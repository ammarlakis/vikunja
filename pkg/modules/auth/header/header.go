// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package header

import (
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"strconv"
	"strings"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/auth"
	"code.vikunja.io/api/pkg/user"
	"github.com/labstack/echo/v5"
	"xorm.io/xorm"
)

func HandleAuth(c *echo.Context) error {
	u, err := Authenticate(c)
	if err != nil {
		return err
	}
	return auth.NewUserAuthTokenResponse(u, c, false, nil)
}

// TokenUserID binds native token exchange and refresh to the authenticated
// gateway identity. Zero means header authentication is disabled.
func TokenUserID(c *echo.Context) (int64, error) {
	if !config.AuthHeaderEnabled.GetBool() {
		return 0, nil
	}
	if c == nil {
		return 0, echo.NewHTTPError(http.StatusUnauthorized, "Missing request context.")
	}
	u, err := Authenticate(c)
	if err != nil {
		return 0, err
	}
	return u.ID, nil
}

// HasIdentity also detects partial headers so malformed gateway requests fail closed.
func HasIdentity(c *echo.Context) bool {
	if !config.AuthHeaderEnabled.GetBool() {
		return false
	}
	for _, key := range []config.Key{config.AuthHeaderSubjectHeader, config.AuthHeaderUsernameHeader, config.AuthHeaderEmailHeader} {
		if len(c.Request().Header.Values(key.GetString())) != 0 {
			return true
		}
	}
	return false
}

func Authenticate(c *echo.Context) (*user.User, error) {
	if !config.AuthHeaderEnabled.GetBool() {
		return nil, echo.ErrNotFound
	}
	// Never use RealIP/X-Forwarded-For to decide who may assert an identity.
	host, _, err := net.SplitHostPort(c.Request().RemoteAddr)
	if err != nil {
		host = c.Request().RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	trusted := false
	if err == nil {
		for _, raw := range config.AuthHeaderTrustedProxies.GetStringSlice() {
			prefix, err := netip.ParsePrefix(raw)
			if err == nil && prefix.Contains(peer.Unmap()) {
				trusted = true
				break
			}
		}
	}
	if !trusted {
		return nil, echo.NewHTTPError(http.StatusForbidden, "Untrusted header authentication proxy.")
	}
	value := func(key config.Key) (string, error) {
		values := c.Request().Header.Values(key.GetString())
		if len(values) != 1 || strings.TrimSpace(values[0]) == "" || strings.ContainsAny(values[0], "\r\n") {
			return "", echo.NewHTTPError(http.StatusUnauthorized, "Missing or ambiguous header identity.")
		}
		return strings.TrimSpace(values[0]), nil
	}
	subject, err := value(config.AuthHeaderSubjectHeader)
	if err != nil {
		return nil, err
	}
	if len(subject) > 200 || strings.ContainsAny(subject, ",= \t") {
		return nil, echo.NewHTTPError(http.StatusUnauthorized, "Invalid header identity.")
	}
	username, err := value(config.AuthHeaderUsernameHeader)
	if err != nil {
		return nil, err
	}
	email, err := value(config.AuthHeaderEmailHeader)
	if err != nil {
		return nil, err
	}
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email {
		return nil, echo.NewHTTPError(http.StatusUnauthorized, "Invalid header email.")
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	u, err := getOrCreateUser(s, "header:"+subject, username, email, getName(c))
	if err != nil {
		_ = s.Rollback()
		return nil, err
	}
	if u.Status != user.StatusActive || u.IsBot() {
		_ = s.Rollback()
		return nil, &user.ErrAccountDisabled{UserID: u.ID}
	}
	if group := config.AuthHeaderAdminGroup.GetString(); group != "" {
		groups := c.Request().Header.Values(config.AuthHeaderGroupsHeader.GetString())
		if len(groups) > 1 {
			return nil, echo.NewHTTPError(http.StatusUnauthorized, "Ambiguous header groups.")
		}
		admin := false
		if len(groups) == 1 {
			for _, name := range strings.Split(groups[0], ",") {
				if strings.TrimSpace(name) == group {
					admin = true
				}
			}
		}
		if u.IsAdmin != admin {
			u.IsAdmin = admin
			if _, err := s.Where("id = ?", u.ID).Cols("is_admin").Update(u); err != nil {
				return nil, err
			}
		}
	}
	if err := s.Commit(); err != nil {
		return nil, err
	}
	events.DispatchPending(c.Request().Context(), s)
	return u, nil
}

func getOrCreateUser(s *xorm.Session, subject, username, email, name string) (*user.User, error) {
	matches := []*user.User{}
	if err := s.Where("issuer = ? AND subject = ?", user.IssuerLocal, subject).Find(&matches); err != nil {
		return nil, err
	}
	if len(matches) > 1 {
		return nil, echo.NewHTTPError(http.StatusForbidden, "Ambiguous header account mapping.")
	}
	var u *user.User
	if len(matches) == 1 {
		u = matches[0]
	}
	if u == nil {
		var linkID int64
		for _, link := range config.AuthHeaderUserLinks.GetStringSlice() {
			key, value, ok := strings.Cut(link, "=")
			if !ok || "header:"+key != subject {
				continue
			}
			id, err := strconv.ParseInt(value, 10, 64)
			if err != nil || id <= 0 || (linkID != 0 && linkID != id) {
				return nil, echo.NewHTTPError(http.StatusForbidden, "Invalid header account mapping.")
			}
			linkID = id
		}
		if linkID != 0 {
			var err error
			u, err = user.GetUserByID(s, linkID)
			if err != nil {
				return nil, err
			}
			if u.Issuer != user.IssuerLocal || u.Subject != "" {
				return nil, echo.NewHTTPError(http.StatusForbidden, "Header account is already linked.")
			}
			// Compare-and-set prevents concurrent identities from claiming the same account.
			changed, err := s.Where("id = ? AND (subject = '' OR subject IS NULL)", u.ID).Cols("subject").Update(&user.User{Subject: subject})
			if err != nil {
				return nil, err
			}
			if changed != 1 {
				return nil, echo.NewHTTPError(http.StatusForbidden, "Header account link changed.")
			}
			u.Subject = subject
		} else {
			if !config.AuthHeaderCreateUser.GetBool() {
				return nil, echo.NewHTTPError(http.StatusForbidden, "Header account is not linked.")
			}
			exists, err := s.Where("username = ? OR email = ?", username, email).Exist(&user.User{})
			if err != nil {
				return nil, err
			}
			if exists {
				return nil, echo.NewHTTPError(http.StatusForbidden, "Existing account requires an explicit header identity link.")
			}
			u, err = user.CreateUserWithRandomPassword(s, &user.User{Username: username, Email: email, Name: name, Subject: subject})
			if err != nil {
				return nil, err
			}
			if err := models.CreateNewProjectForUser(s, u); err != nil {
				return nil, err
			}
		}
	}
	if u.Status != user.StatusActive || u.IsBot() {
		return u, nil
	}
	// Preserve application usernames and ownership; gateway identity is the immutable subject.
	if name != "" && u.Name != name {
		u.Name = name
		if _, err := s.Where("id = ?", u.ID).Cols("name").Update(u); err != nil {
			return nil, err
		}
	}
	return u, nil
}

func getName(c *echo.Context) string {
	name := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderNameHeader.GetString()))
	if name != "" {
		return name
	}
	first := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderFirstNameHeader.GetString()))
	last := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderLastNameHeader.GetString()))
	return strings.TrimSpace(first + " " + last)
}

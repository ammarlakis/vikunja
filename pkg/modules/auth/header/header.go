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
	"net/http"
	"net/mail"
	"strings"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/modules/auth"
	"code.vikunja.io/api/pkg/user"

	"github.com/labstack/echo/v5"
	"xorm.io/xorm"
)

// HandleAuth authenticates a user from trusted reverse-proxy headers and
// returns a normal Vikunja session token response.
func HandleAuth(c *echo.Context) error {
	if !config.AuthHeaderEnabled.GetBool() {
		return echo.ErrNotFound
	}

	username := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderUsernameHeader.GetString()))
	if username == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "No header auth user provided.")
	}

	email := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderEmailHeader.GetString()))
	name := strings.TrimSpace(c.Request().Header.Get(config.AuthHeaderNameHeader.GetString()))

	s := db.NewSession()
	defer s.Close()

	u, err := getOrCreateUser(s, username, email, name)
	if err != nil {
		_ = s.Rollback()
		return err
	}

	if u.Status == user.StatusDisabled || u.Status == user.StatusAccountLocked {
		_ = s.Rollback()
		return &user.ErrAccountDisabled{UserID: u.ID}
	}

	if err := s.Commit(); err != nil {
		_ = s.Rollback()
		return err
	}

	return auth.NewUserAuthTokenResponse(u, c, false)
}

func getOrCreateUser(s *xorm.Session, username, email, name string) (*user.User, error) {
	u, err := user.GetUserWithEmail(s, &user.User{
		Issuer:  user.IssuerHeader,
		Subject: username,
	})
	if err != nil && !user.IsErrUserDoesNotExist(err) && !user.IsErrUserStatusError(err) {
		return nil, err
	}

	if user.IsErrUserStatusError(err) {
		return u, nil
	}

	if user.IsErrUserDoesNotExist(err) {
		if !config.AuthHeaderCreateUser.GetBool() {
			return nil, echo.NewHTTPError(http.StatusForbidden, "Header auth user does not exist.")
		}

		if email == "" && looksLikeEmail(username) {
			email = username
		}

		uu := &user.User{
			Username: strings.ReplaceAll(username, " ", "-"),
			Email:    email,
			Name:     name,
			Status:   user.StatusActive,
			Issuer:   user.IssuerHeader,
			Subject:  username,
		}

		return auth.CreateUserWithRandomUsername(s, uu)
	}

	needsUpdate := false
	if email != "" && u.Email != email {
		u.Email = email
		needsUpdate = true
	}
	if name != "" && u.Name != name {
		u.Name = name
		needsUpdate = true
	}

	if needsUpdate {
		if _, err := s.
			Where("id = ?", u.ID).
			Cols("email", "name").
			Update(u); err != nil {
			return nil, err
		}
	}

	return u, nil
}

func looksLikeEmail(value string) bool {
	_, err := mail.ParseAddress(value)
	return err == nil
}

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

package webtests

import (
	"net/http"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	headerauth "code.vikunja.io/api/pkg/modules/auth/header"
	"code.vikunja.io/api/pkg/user"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHeaderAuth(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)

	config.AuthHeaderEnabled.Set(true)
	config.AuthHeaderUsernameHeader.Set("X-Auth-User")
	config.AuthHeaderEmailHeader.Set("X-Auth-Email")
	config.AuthHeaderNameHeader.Set("X-Auth-Name")

	t.Run("creates user from headers", func(t *testing.T) {
		c, rec := createRequest(e, http.MethodPost, "", nil, nil)
		c.Request().Header.Set("X-Auth-User", "header-user")
		c.Request().Header.Set("X-Auth-Email", "header-user@example.com")
		c.Request().Header.Set("X-Auth-Name", "Header User")

		err := headerauth.HandleAuth(c)
		require.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "token")

		s := db.NewSession()
		defer s.Close()
		u, err := user.GetUserWithEmail(s, &user.User{
			Issuer:  user.IssuerHeader,
			Subject: "header-user",
		})
		require.NoError(t, err)
		assert.Equal(t, "header-user", u.Username)
		assert.Equal(t, "header-user@example.com", u.Email)
		assert.Equal(t, "Header User", u.Name)
	})

	t.Run("signs in existing user without email header", func(t *testing.T) {
		c, rec := createRequest(e, http.MethodPost, "", nil, nil)
		c.Request().Header.Set("X-Auth-User", "header-user")

		err := headerauth.HandleAuth(c)
		require.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "token")
	})

	t.Run("requires configured username header", func(t *testing.T) {
		c, _ := createRequest(e, http.MethodPost, "", nil, nil)

		err := headerauth.HandleAuth(c)
		require.Error(t, err)
		httpErr, ok := err.(*echo.HTTPError)
		require.True(t, ok)
		assert.Equal(t, http.StatusUnauthorized, httpErr.Code)
	})
}

func TestHeaderAuthCreateUserDisabled(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)

	config.AuthHeaderEnabled.Set(true)
	config.AuthHeaderCreateUser.Set(false)
	config.AuthHeaderUsernameHeader.Set("X-Auth-User")

	c, _ := createRequest(e, http.MethodPost, "", nil, nil)
	c.Request().Header.Set("X-Auth-User", "missing-header-user")

	err = headerauth.HandleAuth(c)
	require.Error(t, err)
	httpErr, ok := err.(*echo.HTTPError)
	require.True(t, ok)
	assert.Equal(t, http.StatusForbidden, httpErr.Code)
}

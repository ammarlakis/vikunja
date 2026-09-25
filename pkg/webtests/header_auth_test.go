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
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/routes"
	"code.vikunja.io/api/pkg/user"
	vikunjawebsocket "code.vikunja.io/api/pkg/websocket"
	"github.com/coder/websocket"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupHeaderAuth(t *testing.T) *echo.Echo {
	t.Helper()
	_, err := setupTestEnv()
	require.NoError(t, err)
	config.AuthHeaderEnabled.Set(true)
	config.AuthHeaderTrustedProxies.Set([]string{"192.0.2.0/24"})
	config.AuthHeaderSubjectHeader.Set("Al-User-Id")
	config.AuthHeaderUsernameHeader.Set("Al-Username")
	config.AuthHeaderEmailHeader.Set("Al-Email")
	config.AuthHeaderNameHeader.Set("Al-Name")
	config.AuthHeaderCreateUser.Set(true)
	config.AuthHeaderAdminGroup.Set("")
	config.AuthHeaderUserLinks.Set([]string{"first=1", "second=2", "disabled=17"})
	t.Cleanup(func() {
		config.AuthHeaderEnabled.Set(false)
		config.AuthHeaderUserLinks.Set([]string{})
		config.AuthLocalEnabled.Set(true)
	})
	e := routes.NewEcho()
	routes.RegisterRoutes(e)
	return e
}

func headerRequest(e *echo.Echo, method, path, subject, username, email, token string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(`{"username":"ignored","password":"ignored"}`))
	req.RemoteAddr = "192.0.2.1:1234"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Al-User-Id", subject)
	req.Header.Set("Al-Username", username)
	req.Header.Set("Al-Email", email)
	req.Header.Set("Al-Name", "Gateway Name")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestHeaderAuthTrust(t *testing.T) {
	e := setupHeaderAuth(t)
	cases := []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{"trusted peer", nil, http.StatusOK},
		{"untrusted peer cannot spoof forwarded address", func(r *http.Request) {
			r.RemoteAddr = "198.51.100.1:1234"
			r.Header.Set("X-Forwarded-For", "192.0.2.1")
		}, http.StatusForbidden},
		{"missing immutable identity", func(r *http.Request) { r.Header.Del("Al-User-Id") }, http.StatusUnauthorized},
		{"duplicate identity", func(r *http.Request) { r.Header.Add("Al-User-Id", "second") }, http.StatusUnauthorized},
		{"joined identities", func(r *http.Request) { r.Header.Set("Al-User-Id", "first,second") }, http.StatusUnauthorized},
		{"duplicate email", func(r *http.Request) { r.Header.Add("Al-Email", "user2@example.com") }, http.StatusUnauthorized},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			rec := headerRequest(e, "POST", "/api/v1/auth/header", "first", "user1", "user1@example.com", "", tt.mutate)
			assert.Equal(t, tt.status, rec.Code, rec.Body.String())
		})
	}
	config.AuthHeaderTrustedProxies.Set([]string{})
	rec := headerRequest(e, "POST", "/api/v1/auth/header", "first", "user1", "user1@example.com", "", nil)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestHeaderAuthAccountMapping(t *testing.T) {
	e := setupHeaderAuth(t)
	// Matching mutable names and email addresses never claim existing accounts.
	rec := headerRequest(e, "POST", "/api/v1/auth/header", "unmapped", "user1", "user1@example.com", "", nil)
	assert.NotEqual(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = headerRequest(e, "POST", "/api/v1/auth/header", "first", "user1", "user1@example.com", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = headerRequest(e, "GET", "/api/v2/user", "first", "renamed-in-gateway", "changed@example.com", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var current user.User
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &current))
	assert.EqualValues(t, 1, current.ID)
	assert.Equal(t, "user1", current.Username)
	config.AuthHeaderUserLinks.Set([]string{"attacker=1", "disabled=17"})
	rec = headerRequest(e, "POST", "/api/v1/auth/header", "attacker", "user1", "user1@example.com", "", nil)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	rec = headerRequest(e, "POST", "/api/v1/auth/header", "disabled", "user17", "user17@example.com", "", nil)
	assert.NotEqual(t, http.StatusOK, rec.Code, rec.Body.String())
}

func TestHeaderAuthProvision(t *testing.T) {
	e := setupHeaderAuth(t)
	rec := headerRequest(e, "POST", "/api/v2/auth/header", "new-user", "new-header-user", "new-header@example.com", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	s := db.NewSession()
	defer s.Close()
	u, err := user.GetUserWithEmail(s, &user.User{Username: "new-header-user"})
	require.NoError(t, err)
	assert.Equal(t, "header:new-user", u.Subject)
	assert.Equal(t, user.IssuerLocal, u.Issuer)
	assert.NotEmpty(t, u.Password)
	assert.Equal(t, "Gateway Name", u.Name)
	require.NoError(t, s.Commit())
	rec = headerRequest(e, "POST", "/api/v2/auth/header", "new-user", "new-header-user", "new-header@example.com", "", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	config.AuthHeaderCreateUser.Set(false)
	rec = headerRequest(e, "POST", "/api/v2/auth/header", "another-user", "another-header-user", "another-header@example.com", "", nil)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestHeaderAuthMobileLoginAndAPI(t *testing.T) {
	setupHeaderAuth(t)
	config.AuthLocalEnabled.Set(false)
	e := routes.NewEcho()
	routes.RegisterRoutes(e)
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			denied := humaRequest(t, e, http.MethodPost, "/api/"+version+"/login", `{"username":"user1","password":"12345678"}`, "", "application/json")
			assert.Equal(t, http.StatusUnauthorized, denied.Code, denied.Body.String())
			rec := headerRequest(e, "POST", "/api/"+version+"/login", "first", "user1", "user1@example.com", "", nil)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var login struct {
				Token string `json:"token"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &login))
			require.NotEmpty(t, login.Token)
			for _, token := range []string{"", login.Token} {
				rec = headerRequest(e, "GET", "/api/"+version+"/user", "first", "user1", "user1@example.com", token, nil)
				assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			}
			rec = headerRequest(e, "GET", "/api/"+version+"/user", "second", "user2", "user2@example.com", login.Token, nil)
			assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			// API token 1 belongs to user1 and only allows task reads in the fixtures.
			rec = headerRequest(e, "GET", "/api/"+version+"/user", "first", "user1", "user1@example.com", "tk_2eef46f40ebab3304919ab2e7e39993f75f29d2e", nil)
			assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		})
	}
}

func TestHeaderAuthWebSocketIdentity(t *testing.T) {
	e := setupHeaderAuth(t)
	config.AuthHeaderTrustedProxies.Set([]string{"127.0.0.0/8", "::1/128"})
	vikunjawebsocket.InitHub()
	server := httptest.NewServer(e)
	defer server.Close()
	for _, tc := range []struct {
		name    string
		owner   *user.User
		success bool
	}{
		{"same user", &testuser1, true},
		{"different user", &testuser2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			headers := http.Header{}
			headers.Set("Al-User-Id", "first")
			headers.Set("Al-Username", "user1")
			headers.Set("Al-Email", "user1@example.com")
			conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/ws", &websocket.DialOptions{HTTPHeader: headers})
			require.NoError(t, err)
			defer func() { _ = conn.CloseNow() }()
			message, err := json.Marshal(map[string]string{"action": "auth", "token": humaTokenFor(t, tc.owner)})
			require.NoError(t, err)
			require.NoError(t, conn.Write(ctx, websocket.MessageText, message))
			_, response, err := conn.Read(ctx)
			require.NoError(t, err)
			var result struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
			}
			require.NoError(t, json.Unmarshal(response, &result))
			assert.Equal(t, tc.success, result.Success)
			if !tc.success {
				assert.Equal(t, "invalid_token", result.Error)
			}
		})
	}
}

func TestHeaderAuthAdminRoleSync(t *testing.T) {
	e := setupHeaderAuth(t)
	config.AuthHeaderAdminGroup.Set("app:vikunja:admin")
	t.Cleanup(func() { config.AuthHeaderAdminGroup.Set("") })
	rec := headerRequest(e, "POST", "/api/v2/auth/header", "first", "user1", "user1@example.com", "", func(r *http.Request) { r.Header.Set("Al-Groups", "app:vikunja:admin,app:vikunja:user") })
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var login struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &login))
	rec = headerRequest(e, "GET", "/api/v2/user", "first", "user1", "user1@example.com", login.Token, func(r *http.Request) { r.Header.Set("Al-Groups", "app:vikunja:admin") })
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var current struct {
		IsAdmin bool `json:"is_admin"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &current))
	assert.True(t, current.IsAdmin)
	rec = headerRequest(e, "GET", "/api/v2/user", "first", "user1", "user1@example.com", login.Token, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &current))
	assert.False(t, current.IsAdmin)
	s := db.NewSession()
	defer s.Close()
	u, err := user.GetUserByID(s, 1)
	require.NoError(t, err)
	assert.False(t, u.IsAdmin)
}

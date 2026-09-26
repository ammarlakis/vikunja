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
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"code.vikunja.io/api/pkg/modules/auth"
	"code.vikunja.io/api/pkg/modules/auth/oauth2server"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func headerGrantRequest(t *testing.T, e *echo.Echo, version, endpoint, subject string, params map[string]string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(params)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/"+version+endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if version == "v2" && endpoint == "/oauth/token" {
		form := url.Values{}
		for key, value := range params {
			form.Set(key, value)
		}
		req = httptest.NewRequest(http.MethodPost, "/api/"+version+endpoint, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.RemoteAddr = "192.0.2.1:1234"
	req.Header.Set("Al-User-Id", subject)
	req.Header.Set("Al-Username", "user1")
	req.Header.Set("Al-Email", "user1@example.com")
	if subject == "second" {
		req.Header.Set("Al-Username", "user2")
		req.Header.Set("Al-Email", "user2@example.com")
	}
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func headerCodeGrant(t *testing.T, e *echo.Echo, version string) map[string]string {
	t.Helper()
	rec := headerGrantRequest(t, e, version, "/oauth/authorize", "first", map[string]string{
		"response_type":         "code",
		"client_id":             "vikunja",
		"redirect_uri":          "vikunja-flutter://callback",
		"code_challenge":        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		"code_challenge_method": "S256",
		"state":                 "header-identity-test",
	}, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var code oauth2server.AuthorizeResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &code))
	return map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     "vikunja",
		"redirect_uri":  "vikunja-flutter://callback",
		"code_verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"code":          code.Code,
	}
}

func TestHeaderOAuthSubjectBinding(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			e := setupHeaderAuth(t)
			grant := headerCodeGrant(t, e, version)
			rec := headerGrantRequest(t, e, version, "/oauth/token", "second", grant, nil)
			assert.Equal(t, http.StatusBadRequest, rec.Code, "cross-user authorization code must be rejected")
			grant = headerCodeGrant(t, e, version)
			rec = headerGrantRequest(t, e, version, "/oauth/token", "first", grant, nil)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var tokens oauth2server.TokenResponse
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tokens))
			userID, err := auth.GetUserIDFromToken(tokens.AccessToken)
			require.NoError(t, err)
			assert.EqualValues(t, 1, userID)
			rec = headerGrantRequest(t, e, version, "/oauth/token", "first", grant, nil)
			assert.Equal(t, http.StatusBadRequest, rec.Code, "authorization code replay")
			refresh := map[string]string{"grant_type": "refresh_token", "refresh_token": tokens.RefreshToken}
			rec = headerGrantRequest(t, e, version, "/oauth/token", "second", refresh, nil)
			assert.Equal(t, http.StatusUnauthorized, rec.Code, "cross-user refresh must be rejected before rotation")
			rec = headerGrantRequest(t, e, version, "/oauth/token", "first", refresh, nil)
			require.Equal(t, http.StatusOK, rec.Code, "rejected cross-user refresh must leave owner's token usable: "+rec.Body.String())
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tokens))
			userID, err = auth.GetUserIDFromToken(tokens.AccessToken)
			require.NoError(t, err)
			assert.EqualValues(t, 1, userID)
			rec = headerGrantRequest(t, e, version, "/oauth/token", "first", refresh, nil)
			assert.Equal(t, http.StatusUnauthorized, rec.Code, "refresh token replay")
		})
	}
}

func TestHeaderRefreshIdentityTrust(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		for _, endpoint := range []string{"/oauth/token", "/user/token/refresh"} {
			t.Run(version+endpoint, func(t *testing.T) {
				e := setupHeaderAuth(t)
				grant := headerCodeGrant(t, e, version)
				rec := headerGrantRequest(t, e, version, "/oauth/token", "first", grant, nil)
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				var tokens oauth2server.TokenResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tokens))
				refresh := map[string]string{"grant_type": "refresh_token", "refresh_token": tokens.RefreshToken}
				cases := []struct {
					name    string
					subject string
					status  int
					mutate  func(*http.Request)
				}{
					{"different user", "second", http.StatusUnauthorized, nil},
					{"missing identity", "first", http.StatusUnauthorized, func(r *http.Request) { r.Header.Del("Al-User-Id") }},
					{"untrusted peer", "first", http.StatusForbidden, func(r *http.Request) {
						r.RemoteAddr = "198.51.100.1:1234"
						r.Header.Set("X-Forwarded-For", "192.0.2.1")
					}},
				}
				for _, tc := range cases {
					t.Run(tc.name, func(t *testing.T) {
						rec := headerGrantRequest(t, e, version, endpoint, tc.subject, refresh, func(r *http.Request) {
							r.AddCookie(&http.Cookie{Name: auth.RefreshTokenCookieName, Value: tokens.RefreshToken})
							if tc.mutate != nil {
								tc.mutate(r)
							}
						})
						assert.Equal(t, tc.status, rec.Code, rec.Body.String())
					})
				}
				rec = headerGrantRequest(t, e, version, endpoint, "first", refresh, func(r *http.Request) {
					r.AddCookie(&http.Cookie{Name: auth.RefreshTokenCookieName, Value: tokens.RefreshToken})
				})
				require.Equal(t, http.StatusOK, rec.Code, "owner can still refresh after all rejected attempts: "+rec.Body.String())
			})
		}
	}
}

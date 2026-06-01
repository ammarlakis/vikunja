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

package routes

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"code.vikunja.io/api/pkg/config"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"
)

func TestServeIndexFileKeepsAPIURLRelative(t *testing.T) {
	scriptConfigStringLock.Lock()
	scriptConfigString = ""
	scriptConfigStringLock.Unlock()
	t.Cleanup(func() {
		scriptConfigStringLock.Lock()
		scriptConfigString = ""
		scriptConfigStringLock.Unlock()
		config.ServicePublicURL.Set("")
		config.ServiceFrontendAPIURL.Set("")
	})

	config.ServicePublicURL.Set("https://tasks.example.com/")

	assetFs := http.FS(fstest.MapFS{
		"dist/index.html": &fstest.MapFile{
			Mode: fs.ModePerm,
			Data: []byte(`<div id="app"></div><script>window.API_URL = '/api/v1'</script>`),
		},
	})

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := serveIndexFile(c, assetFs)
	require.NoError(t, err)
	require.Contains(t, rec.Body.String(), "window.API_URL = '/api/v1'")
	require.NotContains(t, rec.Body.String(), "https://tasks.example.com/api/v1")
}

func TestServeIndexFileUsesFrontendAPIURLOverride(t *testing.T) {
	scriptConfigStringLock.Lock()
	scriptConfigString = ""
	scriptConfigStringLock.Unlock()
	t.Cleanup(func() {
		scriptConfigStringLock.Lock()
		scriptConfigString = ""
		scriptConfigStringLock.Unlock()
		config.ServiceFrontendAPIURL.Set("")
	})

	config.ServiceFrontendAPIURL.Set("https://api.example.com/api/v1/")

	assetFs := http.FS(fstest.MapFS{
		"dist/index.html": &fstest.MapFile{
			Mode: fs.ModePerm,
			Data: []byte(`<div id="app"></div><script>window.API_URL = '/api/v1'</script>`),
		},
	})

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := serveIndexFile(c, assetFs)
	require.NoError(t, err)
	require.Contains(t, rec.Body.String(), "window.API_URL = 'https://api.example.com/api/v1'")
	require.NotContains(t, rec.Body.String(), "window.API_URL = '/api/v1'")
}

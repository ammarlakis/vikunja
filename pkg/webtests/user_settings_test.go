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

	"code.vikunja.io/api/pkg/db"
	apiv1 "code.vikunja.io/api/pkg/routes/api/v1"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpdateGeneralUserSettingsPreservesUsername(t *testing.T) {
	payload := `{
		"name": "Header User",
		"email_reminders_enabled": true,
		"discoverable_by_name": true,
		"discoverable_by_email": true,
		"overdue_tasks_reminders_enabled": true,
		"overdue_tasks_reminders_time": "9:00",
		"default_project_id": 0,
		"week_start": 1,
		"language": "en",
		"timezone": "Europe/Berlin",
		"frontend_settings": {}
	}`

	rec, err := newTestRequestWithUser(t, http.MethodPost, apiv1.UpdateGeneralUserSettings, &testuser1, payload, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	s := db.NewSession()
	defer s.Close()

	u, err := user.GetUserByID(s, testuser1.ID)
	require.NoError(t, err)
	assert.Equal(t, "user1", u.Username)
	assert.Equal(t, "Header User", u.Name)
}

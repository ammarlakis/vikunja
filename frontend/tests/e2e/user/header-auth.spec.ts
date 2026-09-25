import {createHash, randomBytes} from 'crypto'
import {test, expect} from '../../support/fixtures'
import {UserFactory} from '../../factories/user'
import {ProjectFactory} from '../../factories/project'
import {login, setupApiUrl} from '../../support/authenticateUser'

// Run with the header provider enabled, loopback trusted, and first=1 second=2 links.
const secondHeaders = {
	'Al-User-Id': 'second',
	'Al-Username': 'second-gateway-user',
	'Al-Email': 'second@example.com',
}

test('Gateway account replaces stored browser account and keeps private projects isolated', async ({page, apiContext}) => {
	const [first, second] = await UserFactory.create(2)
	await ProjectFactory.create(1, {id: 1, owner_id: first.id, title: 'First account private'})
	await ProjectFactory.create(1, {id: 2, owner_id: second.id, title: 'Second account private'}, false)
	const {token} = await login(null, apiContext, first)
	await setupApiUrl(page)
	await page.addInitScript(({token}) => {
		if (!sessionStorage.getItem('header-test-seeded')) {
			localStorage.setItem('token', token)
			sessionStorage.setItem('header-test-seeded', 'true')
		}
	}, {token})
	await page.setExtraHTTPHeaders(secondHeaders)
	await page.goto('/')
	await expect(page.locator('main h1')).toContainText(second.username)
	await expect(page.getByText('Second account private', {exact: true}).first()).toBeVisible()
	await expect(page.getByText('First account private', {exact: true})).toHaveCount(0)
	const activeToken = await page.evaluate(() => localStorage.getItem('token'))
	expect(JSON.parse(Buffer.from(activeToken!.split('.')[1], 'base64url').toString()).id).toBe(second.id)
	const current = await apiContext.get('user', {headers: {...secondHeaders, Authorization: `Bearer ${activeToken}`}})
	expect((await current.json()).id).toBe(second.id)
	const other = await apiContext.get('projects/1', {headers: {...secondHeaders, Authorization: `Bearer ${activeToken}`}})
	expect(other.ok()).toBe(false)
	await page.reload()
	await expect(page.locator('main h1')).toContainText(second.username)
	await expect(page.getByText('First account private', {exact: true})).toHaveCount(0)
})

test('Native app authorization page uses the trusted gateway identity and completes PKCE', async ({page, apiContext}) => {
	await UserFactory.create(2)
	await setupApiUrl(page)
	await page.setExtraHTTPHeaders(secondHeaders)
	const verifier = randomBytes(32).toString('base64url')
	const state = randomBytes(16).toString('base64url')
	const params = new URLSearchParams({
		response_type: 'code', client_id: 'vikunja', redirect_uri: 'vikunja-flutter://callback',
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256', state,
	})
	const authorization = page.waitForResponse(response => response.url().includes('/api/v1/oauth/authorize') && response.request().method() === 'POST')
	await page.goto(`/oauth/authorize?${params}`)
	const response = await authorization
	expect(response.ok()).toBe(true)
	const code = await response.json()
	expect(code.state).toBe(state)
	expect(code.redirect_uri).toBe('vikunja-flutter://callback')
	const exchanged = await apiContext.post('oauth/token', {
		headers: secondHeaders,
		data: {grant_type: 'authorization_code', code: code.code, client_id: 'vikunja', redirect_uri: code.redirect_uri, code_verifier: verifier},
	})
	expect(exchanged.ok()).toBe(true)
	const tokens = await exchanged.json()
	expect(tokens.refresh_token).toBeTruthy()
	const current = await apiContext.get('user', {headers: {...secondHeaders, Authorization: `Bearer ${tokens.access_token}`}})
	expect((await current.json()).id).toBe(2)
})

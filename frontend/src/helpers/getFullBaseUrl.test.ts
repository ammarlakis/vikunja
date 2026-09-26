import {afterEach, describe, expect, it, vi} from 'vitest'
import {getFullBaseUrl, getGatewayBaseUrl} from './getFullBaseUrl'

describe('runtime frontend base', () => {
	afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
	function path(pathname: string) { vi.stubGlobal('window', {location: {pathname}}) }

	it('uses the root for relative builds opened on a nested route', () => {
		vi.stubEnv('BASE_URL', './')
		path('/oauth/authorize')
		expect(getFullBaseUrl()).toBe('/')
	})
	it('retains the credential prefix on nested routes and bare device URLs', () => {
		const prefix = '/al_' + 'A'.repeat(43)
		for (const suffix of ['', '/', '/oauth/authorize']) {
			path(prefix + suffix)
			expect(getGatewayBaseUrl()).toBe(prefix + '/')
			expect(getFullBaseUrl()).toBe(prefix + '/')
		}
	})
	it('rejects malformed and encoded prefixes', () => {
		for (const prefix of ['/al_short/', '/al_' + 'A'.repeat(44) + '/', '/al_' + 'A'.repeat(43) + '.evil/', '/%61l_' + 'A'.repeat(43) + '/']) {
			path(prefix)
			expect(getGatewayBaseUrl()).toBeUndefined()
		}
	})
	it('preserves a configured installation base', () => {
		vi.stubEnv('BASE_URL', '/vikunja')
		path('/vikunja/login')
		expect(getFullBaseUrl()).toBe('/vikunja/')
	})
	it('does not require a browser window in the service worker', () => {
		vi.stubGlobal('window', undefined)
		vi.stubEnv('BASE_URL', './')
		expect(getFullBaseUrl()).toBe('/')
	})
})

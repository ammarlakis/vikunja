import {afterEach, describe, expect, it, vi} from 'vitest'
import setupSentry from './sentry'

const mocks = vi.hoisted(() => ({init: vi.fn()}))
vi.mock('@sentry/vue', () => ({init: mocks.init}))

describe('telemetry startup guard', () => {
	afterEach(() => { vi.unstubAllGlobals(); mocks.init.mockClear() })
	it('does not initialize after a credential switch while the SDK import is pending', async () => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: 'https://tasks.example/api/v1', SENTRY_ENABLED: true})
		const setup = setupSentry({} as never, {} as never)
		window.SENTRY_ENABLED = false
		await setup
		expect(mocks.init).not.toHaveBeenCalled()
	})
	it('refuses credential API targets even on an ordinary page', async () => {
		vi.stubGlobal('window', {location: new URL('app://vikunja/index.html'), API_URL: 'https://tasks.example/al_' + 'A'.repeat(43) + '/api/v1', SENTRY_ENABLED: true})
		await setupSentry({} as never, {} as never)
		expect(mocks.init).not.toHaveBeenCalled()
	})
})

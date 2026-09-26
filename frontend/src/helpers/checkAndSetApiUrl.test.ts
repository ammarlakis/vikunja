import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {checkAndSetApiUrl} from './checkAndSetApiUrl'

const mocks = vi.hoisted(() => ({
	clear: vi.fn(),
	configure: vi.fn(),
	update: vi.fn(),
	telemetryClose: vi.fn(),
	replayStop: vi.fn(),
	telemetryOptions: {enabled: true},
}))

vi.mock('@sentry/vue', () => ({
	getClient: () => ({getOptions: () => mocks.telemetryOptions, close: mocks.telemetryClose}),
	getReplay: () => ({stop: mocks.replayStop}),
}))

vi.mock('@/stores/config', () => ({
	useConfigStore: () => ({update: mocks.update}),
}))

vi.mock('@/client/http', () => ({
	configureApiClient: mocks.configure,
}))

vi.mock('@/client/queryClient', () => ({
	queryClient: {clear: mocks.clear},
}))

describe('checkAndSetApiUrl query lifecycle', () => {
	beforeEach(() => {
		window.API_URL = 'https://old.example.com/api/v1'
		localStorage.clear()
		mocks.clear.mockReset()
		mocks.configure.mockReset()
		mocks.update.mockReset()
	})

	it('reconfigures the client and clears cache after accepting a different server', async () => {
		mocks.update.mockResolvedValue(true)

		await expect(checkAndSetApiUrl('https://new.example.com/api/v1')).resolves.toBe('https://new.example.com/api/v1')

		expect(mocks.configure).toHaveBeenCalledOnce()
		expect(mocks.clear).toHaveBeenCalledOnce()
	})

	it('keeps the current client and cache when the server does not change', async () => {
		mocks.update.mockResolvedValue(true)

		await checkAndSetApiUrl('https://old.example.com/api/v1')

		expect(mocks.configure).not.toHaveBeenCalled()
		expect(mocks.clear).not.toHaveBeenCalled()
	})

	it('keeps the current client and cache when every candidate is rejected', async () => {
		mocks.update.mockRejectedValue(new Error('unreachable'))

		await expect(checkAndSetApiUrl('https://new.example.com')).rejects.toThrow('unreachable')

		expect(window.API_URL).toBe('https://old.example.com/api/v1')
		expect(mocks.configure).not.toHaveBeenCalled()
		expect(mocks.clear).not.toHaveBeenCalled()
	})
})

describe('credential API URL isolation', () => {
	const prefix = '/al_' + 'A'.repeat(43)
	const apiUrl = 'https://tasks.example' + prefix + '/api/v1'
	beforeEach(() => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example' + prefix + '/projects'), API_URL: apiUrl})
		localStorage.clear()
		mocks.update.mockReset()
		mocks.configure.mockReset()
		mocks.clear.mockReset()
	})
	afterEach(() => vi.unstubAllGlobals())

	it('never stores a browser credential URL in origin-wide settings', async () => {
		mocks.update.mockResolvedValue(true)
		await checkAndSetApiUrl(apiUrl)
		expect(localStorage.getItem('API_URL')).toBeNull()
	})
	it('refuses another origin before sending a request from a credential page', async () => {
		mocks.update.mockResolvedValue(true)
		await expect(Promise.resolve().then(() => checkAndSetApiUrl('https://other.example' + prefix + '/api/v1'))).rejects.toThrow('invalid')
		expect(mocks.update).not.toHaveBeenCalled()
		expect(window.API_URL).toBe(apiUrl)
	})
	it('attempts a credential target once, never redirects or logs its URL, and sanitizes errors', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		mocks.update.mockRejectedValue(new Error('request failed: ' + apiUrl))
		try {
			await expect(checkAndSetApiUrl(apiUrl)).rejects.toThrow('The provided API URL is invalid.')
			expect(mocks.update).toHaveBeenCalledExactlyOnceWith({redirect: 'error'})
			expect(warn).not.toHaveBeenCalled()
			expect(window.API_URL).toBe(apiUrl)
		} finally { warn.mockRestore() }
	})
})

describe('credential target boundaries', () => {
	const prefix = '/al_' + 'A'.repeat(43)
	const apiUrl = 'https://tasks.example' + prefix + '/api/v1'
	beforeEach(() => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example' + prefix + '/'), API_URL: apiUrl})
		localStorage.clear()
		mocks.update.mockReset()
		mocks.configure.mockReset()
		mocks.clear.mockReset()
	})
	afterEach(() => vi.unstubAllGlobals())
	it.each([
		'https://tasks.example:3456' + prefix + '/api/v1',
		'https://tasks.example/api/v1',
		'https://tasks.example/al_' + 'B'.repeat(43) + '/api/v1',
		apiUrl + '?forward=https://other.example',
		apiUrl + '#ignored',
	])('rejects a changed credential endpoint without a request', async candidate => {
		await expect(Promise.resolve().then(() => checkAndSetApiUrl(candidate))).rejects.toThrow('invalid')
		expect(mocks.update).not.toHaveBeenCalled()
		expect(window.API_URL).toBe(apiUrl)
	})
	it.each(['HTTPS://TASKS.EXAMPLE', '//tasks.example'])('normalizes an explicit HTTP origin without changing its host', origin => {
		mocks.update.mockResolvedValue(true)
		return expect(checkAndSetApiUrl(origin + prefix + '/api/v1')).resolves.toBe(apiUrl)
	})
	it('uses HTTPS for a scheme-less native credential server', async () => {
		vi.stubGlobal('window', {location: new URL('app://vikunja/index.html'), API_URL: '', vikunjaDesktop: {isDesktop: true}})
		mocks.update.mockResolvedValue(true)
		await expect(checkAndSetApiUrl('tasks.example' + prefix + '/')).resolves.toBe(apiUrl)
	})

	it('preserves an ordinary saved browser server while visiting a credential URL', async () => {
		localStorage.setItem('API_URL', 'https://ordinary.example/api/v1')
		mocks.update.mockResolvedValue(true)
		await checkAndSetApiUrl(apiUrl)
		expect(localStorage.getItem('API_URL')).toBe('https://ordinary.example/api/v1')
	})
	it('keeps intentional native custom-server storage and makes one exact API probe', async () => {
		vi.stubGlobal('window', {location: new URL('app://vikunja/index.html'), API_URL: '', vikunjaDesktop: {isDesktop: true}})
		mocks.update.mockResolvedValue(true)
		await expect(checkAndSetApiUrl('https://tasks.example' + prefix + '/')).resolves.toBe(apiUrl)
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({redirect: 'error'})
		expect(localStorage.getItem('API_URL')).toBe(apiUrl)
	})
	it('does not probe another port or expose failures for native credential targets', async () => {
		vi.stubGlobal('window', {location: new URL('app://vikunja/index.html'), API_URL: '', vikunjaDesktop: {isDesktop: true}})
		mocks.update.mockRejectedValue(new Error('private failure ' + apiUrl))
		const error = await checkAndSetApiUrl(apiUrl).catch(error => error)
		expect(error.message).toBe('The provided API URL is invalid.')
		expect(error.cause).toBeUndefined()
		expect(mocks.update).toHaveBeenCalledOnce()
		expect(window.API_URL).toBe('')
		expect(localStorage.getItem('API_URL')).toBeNull()
	})
	it.each(['/../api/v1', '/%2e%2e/api/v1'])('rejects credential-removing normalization before any request', suffix => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: 'https://tasks.example/api/v1'})
		mocks.update.mockResolvedValue(true)
		expect(() => checkAndSetApiUrl('https://tasks.example' + prefix + suffix)).toThrow('invalid')
		expect(mocks.update).not.toHaveBeenCalled()
		expect(localStorage.getItem('API_URL')).toBeNull()
	})
	it('rejects a relative credential path removed by URL normalization', () => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: 'https://tasks.example/api/v1'})
		mocks.update.mockResolvedValue(true)
		expect(() => checkAndSetApiUrl(prefix + '/../api/v1')).toThrow('invalid')
		expect(mocks.update).not.toHaveBeenCalled()
	})

	it.each(['/%', '/%E0%A4%A'])('never falls back or logs a credential with a malformed suffix', async suffix => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: 'https://tasks.example/api/v1'})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		mocks.update.mockRejectedValue(new Error('private ' + apiUrl + suffix))
		try {
			await expect(checkAndSetApiUrl(apiUrl + suffix)).rejects.toThrow('The provided API URL is invalid.')
			expect(mocks.update).toHaveBeenCalledExactlyOnceWith({redirect: 'error'})
			expect(warn).not.toHaveBeenCalled()
			expect(localStorage.getItem('API_URL')).toBeNull()
		} finally { warn.mockRestore() }
	})

	it.each([prefix + '.invalid', prefix + '%', prefix.replace('/al_', '/%61l_') + '%'])('treats credential material as private even with an invalid suffix', async target => {
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: 'https://tasks.example/api/v1'})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		mocks.update.mockRejectedValue(new Error('private ' + target))
		try {
			await expect(checkAndSetApiUrl('https://tasks.example' + target)).rejects.toThrow('The provided API URL is invalid.')
			expect(mocks.update).toHaveBeenCalledExactlyOnceWith({redirect: 'error'})
			expect(warn).not.toHaveBeenCalled()
			expect(localStorage.getItem('API_URL')).toBeNull()
		} finally { warn.mockRestore() }
	})

	it('rejects an invalid config response without persisting or switching the client', async () => {
		mocks.update.mockResolvedValue(false)
		await expect(checkAndSetApiUrl(apiUrl)).rejects.toThrow('invalid')
		expect(localStorage.getItem('API_URL')).toBeNull()
		expect(mocks.configure).not.toHaveBeenCalled()
	})
})

describe('live credential API telemetry shutdown', () => {
	afterEach(() => vi.unstubAllGlobals())
	it('stops replay and disables the client before concurrent probes, staying disabled after failure', async () => {
		const ordinary = 'https://tasks.example/api/v1'
		const credential = 'https://tasks.example/al_' + 'A'.repeat(43) + '/api/v1'
		vi.stubGlobal('window', {location: new URL('https://tasks.example/'), API_URL: ordinary, SENTRY_ENABLED: true})
		mocks.update.mockReset().mockRejectedValue(new Error('private ' + credential))
		mocks.replayStop.mockResolvedValue(undefined)
		let finishClose: () => void = () => {}
		mocks.telemetryClose.mockImplementation(() => new Promise<void>(resolve => { finishClose = resolve }))
		const first = checkAndSetApiUrl(credential).catch(error => error)
		const second = checkAndSetApiUrl(credential).catch(error => error)
		await vi.waitFor(() => expect(mocks.telemetryClose).toHaveBeenCalledExactlyOnceWith(1))
		expect(window.SENTRY_ENABLED).toBe(false)
		expect(mocks.telemetryOptions.enabled).toBe(false)
		expect(mocks.replayStop).toHaveBeenCalledExactlyOnceWith({flush: false})
		expect(mocks.update).not.toHaveBeenCalled()
		expect(window.API_URL).toBe(ordinary)
		finishClose()
		const errors = await Promise.all([first, second])
		expect(errors.every(error => error.message === 'The provided API URL is invalid.')).toBe(true)
		expect(mocks.update).toHaveBeenCalledTimes(2)
		expect(window.API_URL).toBe(ordinary)
		expect(window.SENTRY_ENABLED).toBe(false)
	})
})

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {hasGatewayCredential, restoreSavedApiUrl, usesGatewayCredential} from './gatewayApi'

describe('safe saved API restoration', () => {
	const prefix = '/al_' + 'A'.repeat(43)
	const ordinary = 'https://tasks.example/api/v1'
	const credential = 'https://tasks.example' + prefix + '/api/v1'
	function page(path = '/', desktop = false) {
		vi.stubGlobal('window', {location: new URL(desktop ? 'app://vikunja/index.html' : 'https://tasks.example' + path), API_URL: ordinary, vikunjaDesktop: {isDesktop: desktop}})
	}
	beforeEach(() => { localStorage.clear(); page() })
	afterEach(() => vi.unstubAllGlobals())
	it('clears a legacy credential URL on canonical browser startup', () => {
		localStorage.setItem('API_URL', credential)
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(ordinary)
		expect(localStorage.getItem('API_URL')).toBeNull()
		expect(usesGatewayCredential()).toBe(false)
	})
	it('pins a credential visit to its own identity and ignores an older saved identity', () => {
		localStorage.setItem('API_URL', credential.replace('al_A', 'al_B'))
		page(prefix + '/projects')
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(credential)
		expect(localStorage.getItem('API_URL')).toBeNull()
		expect(usesGatewayCredential()).toBe(true)
		page()
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(ordinary)
	})
	it.each([
		'https://tasks.example' + String.fromCharCode(92) + prefix.slice(1) + '/api/v1',
		credential.replace('al_', 'al_\n'),
		credential.replace('al_', 'al_\t'),
	])('clears legacy credentials normalized by the URL parser', saved => {
		localStorage.setItem('API_URL', saved)
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(ordinary)
		expect(localStorage.getItem('API_URL')).toBeNull()
	})

	it('keeps an ordinary browser server setting for a later canonical visit', () => {
		const custom = 'https://ordinary.example/api/v1'
		localStorage.setItem('API_URL', custom)
		page(prefix + '/')
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(credential)
		page()
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(custom)
	})
	it('restores an intentional desktop credential server and disables telemetry', () => {
		localStorage.setItem('API_URL', credential)
		page('/', true)
		restoreSavedApiUrl()
		expect(window.API_URL).toBe(credential)
		expect(localStorage.getItem('API_URL')).toBe(credential)
		expect(usesGatewayCredential()).toBe(true)
	})
	it.each(['/%', '/%E0%A4%A', '/../api/v1', '.invalid', '%'])('recognizes a raw credential even with an invalid or normalized suffix', suffix => {
		expect(hasGatewayCredential('https://tasks.example' + prefix + suffix)).toBe(true)
		expect(hasGatewayCredential('https://tasks.example' + prefix.replace('/al_', '/%61l_') + suffix)).toBe(true)
	})

	it('disables telemetry on a page containing credential material with an invalid suffix', () => {
		page(prefix + '.invalid')
		expect(usesGatewayCredential()).toBe(true)
	})

	it('recognizes encoded or nested credential paths when clearing legacy settings', () => {
		expect(hasGatewayCredential('https://tasks.example/base/' + prefix.slice(1) + '/api/v1')).toBe(true)
		expect(hasGatewayCredential(credential.replace('/al_', '/%61l_'))).toBe(true)
		expect(hasGatewayCredential('https://tasks.example/al_short/api/v1')).toBe(false)
		expect(hasGatewayCredential(null)).toBe(false)
	})
})

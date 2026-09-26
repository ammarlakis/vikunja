import {afterEach, describe, expect, it, vi} from 'vitest'
import {prepareGatewaySession} from './gatewaySession'

describe('credential URL service worker transition', () => {
	afterEach(() => vi.unstubAllGlobals())
	const prefix = '/al_' + 'A'.repeat(43)
	function setup(controlled: boolean, pathname = prefix + '/oauth/authorize') {
		const reload = vi.fn()
		const unregister = vi.fn(async () => true)
		const registrations = vi.fn(async () => [{scope: 'https://tasks.example/', unregister}])
		const cached = [{url: 'https://tasks.example' + prefix + '/assets/main.js'}, {url: 'https://tasks.example/assets/root.js'}]
		const remove = vi.fn(async () => true)
		const storage = {keys: async () => ['assets'], open: async () => ({keys: async () => cached, delete: remove})}
		vi.stubGlobal('window', {location: {pathname, href: 'https://tasks.example' + pathname, origin: 'https://tasks.example', reload}, caches: storage})
		vi.stubGlobal('navigator', {serviceWorker: {controller: controlled ? {} : null, getRegistrations: registrations}})
		vi.stubGlobal('caches', storage)
		return {reload, unregister, registrations, remove, cached}
	}
	it('unregisters the old controller, removes credential cache entries and reloads before mounting', async () => {
		const state = setup(true)
		expect(await prepareGatewaySession()).toBe(false)
		expect(state.unregister).toHaveBeenCalledTimes(1)
		expect(state.remove).toHaveBeenCalledExactlyOnceWith(state.cached[0])
		expect(state.reload).toHaveBeenCalledTimes(1)
	})
	it('starts after reloading without a service worker and clears any leftover credential entries', async () => {
		const state = setup(false)
		expect(await prepareGatewaySession()).toBe(true)
		expect(state.remove).toHaveBeenCalledExactlyOnceWith(state.cached[0])
		expect(state.reload).not.toHaveBeenCalled()
	})
	it('leaves ordinary browser sessions unchanged', async () => {
		const state = setup(true, '/projects')
		expect(await prepareGatewaySession()).toBe(true)
		expect(state.registrations).not.toHaveBeenCalled()
		expect(state.remove).not.toHaveBeenCalled()
	})
})

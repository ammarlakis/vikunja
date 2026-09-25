import {createPinia, setActivePinia} from 'pinia'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {queryClient} from '@/client/queryClient'
import {AUTH_TYPES} from '@/modelTypes/IUser'
import {getToken, removeToken, saveToken} from '@/helpers/auth'
import {useConfigStore} from '@/stores/config'
import {useAuthStore} from './auth'

const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn(), authenticatedGet: vi.fn()}))
vi.mock('@/helpers/fetcher', () => ({
	HTTPFactory: () => ({get: http.get, post: http.post, interceptors: {request: {use: vi.fn()}, response: {use: vi.fn()}}}),
	AuthenticatedHTTPFactory: () => ({get: http.authenticatedGet, post: http.post, interceptors: {request: {use: vi.fn()}, response: {use: vi.fn()}}}),
	getApiBaseUrl: () => 'http://localhost/api/v1/',
	apiV2Url: (path: string) => `http://localhost/api/v2/${path}`,
}))
vi.mock('@/router', () => ({default: {push: vi.fn()}}))
vi.mock('@/composables/useWebSocket', () => ({useWebSocket: () => ({disconnect: vi.fn()})}))
vi.mock('@/helpers/redirectToProvider', () => ({
	getRedirectUrlFromCurrentFrontendPath: vi.fn(),
	redirectToProvider: vi.fn(),
	redirectToProviderOnLogout: vi.fn(),
}))

function jwt(id: number) {
	return `header.${btoa(JSON.stringify({id, username: `user${id}`, type: AUTH_TYPES.USER, exp: Math.floor(Date.now() / 1000) + 3600}))}.signature`
}
const currentUser = {id: 2, username: 'user2', name: 'Second User', settings: {}}

describe('trusted header identity bootstrap', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		queryClient.clear()
		localStorage.clear()
		removeToken()
		http.get.mockReset().mockResolvedValue({data: currentUser})
		http.post.mockReset().mockResolvedValue({data: {token: jwt(2)}})
		http.authenticatedGet.mockReset().mockResolvedValue({data: currentUser})
		useConfigStore().auth.header.enabled = true
	})

	it('replaces another account JWT and clears that account query cache', async () => {
		saveToken(jwt(1), true)
		const store = useAuthStore()
		store.setUser({id: 1, type: AUTH_TYPES.USER} as never, false)
		queryClient.setQueryData(['private-projects'], [{id: 1, title: 'First user only'}])
		await store.checkAuth()
		expect(http.get).toHaveBeenCalledWith('/user')
		expect(http.post).toHaveBeenCalledWith('/auth/header')
		expect(store.info?.id).toBe(2)
		expect(store.authenticated).toBe(true)
		expect(queryClient.getQueryData(['private-projects'])).toBeUndefined()
	})

	it('keeps a current same-user session without creating another session', async () => {
		const token = jwt(2)
		saveToken(token, true)
		await useAuthStore().checkAuth()
		expect(http.get).toHaveBeenCalledWith('/user')
		expect(http.post).not.toHaveBeenCalled()
		expect(getToken()).toBe(token)
	})

	it('clears cached identity and token when the gateway denies authentication', async () => {
		saveToken(jwt(1), true)
		const store = useAuthStore()
		store.setAuthenticated(true)
		store.setUser({id: 1, type: AUTH_TYPES.USER} as never, false)
		http.get.mockRejectedValue({response: {status: 403}})
		await store.checkAuth()
		expect(store.info).toBeNull()
		expect(store.authenticated).toBe(false)
		expect(getToken()).toBeNull()
		expect(http.authenticatedGet).not.toHaveBeenCalled()
	})

	it('shares a pending bootstrap across simultaneous auth checks', async () => {
		let resolve: (value: unknown) => void = () => {}
		http.get.mockReturnValue(new Promise(r => {resolve = r}))
		const store = useAuthStore()
		const first = store.checkAuth()
		const second = store.checkAuth()
		resolve({data: currentUser})
		await Promise.all([first, second])
		expect(http.get).toHaveBeenCalledTimes(1)
		expect(http.post).toHaveBeenCalledTimes(1)
		expect(store.info?.id).toBe(2)
	})
})

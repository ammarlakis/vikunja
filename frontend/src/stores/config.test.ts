import {describe, it, expect, beforeEach, vi} from 'vitest'
import {setActivePinia, createPinia} from 'pinia'
import {computed} from 'vue'

import {useConfigStore} from './config'

const mocks = vi.hoisted(() => ({get: vi.fn()}))
vi.mock('@/helpers/fetcher', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/fetcher')>(),
	HTTPFactory: () => ({get: mocks.get}),
}))

describe('config store', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		mocks.get.mockReset()
	})

	it('passes redirect rejection to the actual fetch transport for credential validation', async () => {
		mocks.get.mockResolvedValue({data: {version: 'test'}})
		await useConfigStore().update({redirect: 'error'})
		expect(mocks.get).toHaveBeenCalledExactlyOnceWith('info', {
			adapter: 'fetch',
			fetchOptions: {redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'},
		})
	})

	describe('isProFeatureEnabled', () => {
		it('returns true when the feature is in the enabledProFeatures list', () => {
			const store = useConfigStore()
			store.enabledProFeatures = ['admin_panel']
			expect(store.isProFeatureEnabled('admin_panel')).toBe(true)
		})

		it('returns false for features not present in the list', () => {
			const store = useConfigStore()
			store.enabledProFeatures = ['admin_panel']
			expect(store.isProFeatureEnabled('time_tracking')).toBe(false)
		})

		it('returns false when the list is empty (free mode)', () => {
			const store = useConfigStore()
			store.enabledProFeatures = []
			expect(store.isProFeatureEnabled('admin_panel')).toBe(false)
		})

		it('reacts to store updates when wrapped in computed', () => {
			const store = useConfigStore()
			store.enabledProFeatures = []
			const enabled = computed(() => store.isProFeatureEnabled('admin_panel'))
			expect(enabled.value).toBe(false)
			store.enabledProFeatures = ['admin_panel']
			expect(enabled.value).toBe(true)
		})
	})
})

import {getGatewayBaseUrl} from './getFullBaseUrl'

/** Leave an existing root service worker before an authenticated device session starts. */
export async function prepareGatewaySession(): Promise<boolean> {
	if (!getGatewayBaseUrl() || !('serviceWorker' in navigator)) return true

	const controlled = Boolean(navigator.serviceWorker.controller)
	if (controlled) {
		const registrations = await navigator.serviceWorker.getRegistrations()
		for (const registration of registrations) {
			if (window.location.href.startsWith(registration.scope)) {
				await registration.unregister()
			}
		}
	}
	// Earlier workers may have stored credential URLs as cache keys. Remove those entries.
	if ('caches' in window) {
		for (const name of await caches.keys()) {
			const cache = await caches.open(name)
			for (const request of await cache.keys()) {
				const url = new URL(request.url)
				if (url.origin === window.location.origin && /^\/al_[A-Za-z0-9_-]{43}(?:\/|$)/.test(url.pathname)) {
					await cache.delete(request)
				}
			}
		}
	}
	if (controlled) {
		window.location.reload()
		return false
	}
	return true
}

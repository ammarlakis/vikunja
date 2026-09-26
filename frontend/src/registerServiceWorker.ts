import {register} from 'register-service-worker'

import {getFullBaseUrl, getGatewayBaseUrl} from './helpers/getFullBaseUrl'

// Credential URLs are revocable device credentials; keep their requests on the network.
if (import.meta.env.PROD && !getGatewayBaseUrl()) {
	register(getFullBaseUrl() + 'sw.js', {
		ready() {
			console.log('App is being served from cache by a service worker.')
		},
		registered() {
			console.log('Service worker has been registered.')
		},
		cached() {
			console.log('Content has been cached for offline use.')
		},
		updatefound() {
			console.log('New content is downloading.')
		},
		updated(registration) {
			console.log('New content is available; please refresh.')
			// Send an event with the updated info
			document.dispatchEvent(
				new CustomEvent('swUpdated', {detail: registration}),
			)
		},
		offline() {
			console.log('No internet connection found. App is running in offline mode.')
		},
		error(error) {
			console.error('Error during service worker registration:', error)
		},
	})
}

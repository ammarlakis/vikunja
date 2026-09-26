import {useConfigStore} from '@/stores/config'
import {configureApiClient} from '@/client/http'
import {queryClient} from '@/client/queryClient'
import {getGatewayBaseUrl} from './getFullBaseUrl'
import {disableGatewayTelemetry, hasGatewayCredential, preservesGatewayCredential, saveApiUrl} from './gatewayApi'

const API_DEFAULT_PORT = '3456'
const API_PATH_SUFFIX = '/api/v1'

export const ERROR_NO_API_URL = 'noApiUrlProvided'

export class NoApiUrlProvidedError extends Error {
	constructor() {
		super()
		this.message = 'No API URL provided'
		this.name = 'NoApiUrlProvidedError'
	}
}

export class InvalidApiUrlProvidedError extends Error {
	constructor() {
		super()
		this.message = 'The provided API URL is invalid.'
		this.name = 'InvalidApiUrlProvidedError'
	}
}

/**
 * Join a base pathname with the API_DEFAULT_PATH, normalizing slashes between them.
 */
function joinPath(base: string, suffix: string): string {
	const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
	return normalizedBase + suffix
}

/**
 * Check whether a pathname already ends with the API default path,
 * with or without a trailing slash.
 */
function hasApiPath(pathname: string): boolean {
	const clean = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
	return clean.endsWith(API_PATH_SUFFIX)
}

export const checkAndSetApiUrl = (pUrl: string | undefined | null): Promise<string> => {
	let url = pUrl
	if (url === '' || url === null || typeof url === 'undefined') {
		throw new NoApiUrlProvidedError()
	}

	const suppliedUrl = url
	const protocol = /^https?:$/.test(window.location.protocol) ? window.location.protocol : 'https:'
	if (url.startsWith('//')) {
		url = protocol + url
	} else if (url.startsWith('/')) {
		url = new URL(url, window.location.href).href
	} else if (!/^https?:\/\//i.test(url)) {
		if (url.includes('://')) throw new InvalidApiUrlProvidedError()
		url = `${protocol}//${url}`
	}

	let urlToCheck: URL
	try {
		urlToCheck = new URL(url)
		if (!/^https?:$/.test(urlToCheck.protocol)) throw new InvalidApiUrlProvidedError()
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
	} catch (e) {
		throw new InvalidApiUrlProvidedError()
	}

	if (!preservesGatewayCredential(suppliedUrl, urlToCheck.pathname)) {
		throw new InvalidApiUrlProvidedError()
	}

	const prefix = getGatewayBaseUrl()
	if (prefix) {
		const expected = new URL(prefix + 'api/v1', window.location.origin)
		if (
			urlToCheck.origin !== expected.origin ||
			urlToCheck.pathname.replace(/\/$/, '') !== expected.pathname ||
			urlToCheck.username || urlToCheck.password || urlToCheck.search || urlToCheck.hash
		) {
			throw new InvalidApiUrlProvidedError()
		}
		urlToCheck = expected
	}

	// Credential targets get one exact request: never probe another port or follow a redirect.
	if (prefix || hasGatewayCredential(urlToCheck.href)) {
		if (urlToCheck.username || urlToCheck.password || urlToCheck.search || urlToCheck.hash) {
			throw new InvalidApiUrlProvidedError()
		}
		if (!hasApiPath(urlToCheck.pathname)) {
			urlToCheck.pathname = joinPath(urlToCheck.pathname, API_PATH_SUFFIX)
		}
		const oldUrl = window.API_URL
		return disableGatewayTelemetry().then(() => {
			window.API_URL = urlToCheck.href.replace(/\/$/, '')
			return useConfigStore().update({redirect: 'error'})
		}).then(success => {
			if (!success) throw new InvalidApiUrlProvidedError()
			if (window.API_URL !== oldUrl) {
				configureApiClient()
				queryClient.clear()
			}
			saveApiUrl(window.API_URL)
			return window.API_URL
		}).catch(() => {
			window.API_URL = oldUrl
			// Axios errors retain the complete credential URL in their message/config.
			throw new InvalidApiUrlProvidedError()
		})
	}

	const origPathname = urlToCheck.pathname

	const oldUrl = window.API_URL
	window.API_URL = urlToCheck.toString()

	const configStore = useConfigStore()

	// Check if the api is reachable at the provided url
	return configStore.update()
		.catch(e => {
			console.warn(`Could not fetch 'info' from the provided endpoint ${pUrl} on ${window.API_URL}/info. Some automatic fallback will be tried.`)
			// Check if it is reachable at the base path + /api/v1 via http
			if (!hasApiPath(urlToCheck.pathname)) {
				urlToCheck.pathname = joinPath(urlToCheck.pathname, API_PATH_SUFFIX)
				window.API_URL = urlToCheck.toString()
				return configStore.update()
			}
			throw e
		})
		.catch(e => {
			// Check if it is reachable at the base path + /api/v1 via https
			urlToCheck.pathname = origPathname
			if (!hasApiPath(urlToCheck.pathname)) {
				urlToCheck.pathname = joinPath(urlToCheck.pathname, API_PATH_SUFFIX)
				window.API_URL = urlToCheck.toString()
				return configStore.update()
			}
			throw e
		})
		.catch(e => {
			// Check if it is reachable at port API_DEFAULT_PORT and https
			if (urlToCheck.port !== API_DEFAULT_PORT) {
				urlToCheck.port = API_DEFAULT_PORT
				window.API_URL = urlToCheck.toString()
				return configStore.update()
			}
			throw e
		})
		.catch(e => {
			// Check if it is reachable at :API_DEFAULT_PORT with base path + /api/v1
			urlToCheck.pathname = origPathname
			if (!hasApiPath(urlToCheck.pathname)) {
				urlToCheck.pathname = joinPath(urlToCheck.pathname, API_PATH_SUFFIX)
				window.API_URL = urlToCheck.toString()
				return configStore.update()
			}
			throw e
		})
		.catch(e => {
			window.API_URL = oldUrl
			throw e
		})
		.then(success => {
			if (success) {
				if (window.API_URL !== oldUrl) {
					configureApiClient()
					queryClient.clear()
				}
				saveApiUrl(window.API_URL)
				return window.API_URL
			}

			throw new InvalidApiUrlProvidedError()
		})
}

import {isDesktopApp} from './desktopAuth'
import {getGatewayBaseUrl} from './getFullBaseUrl'

// Examine the supplied string before URL dot-segment normalization. Decode each
// segment separately so malformed suffixes cannot hide an earlier credential.
function gatewayCredential(value: string | undefined | null): string | undefined {
	if (!value) return undefined
	for (const segment of value.trim().replace(/[\t\r\n]/g, '').split(/[\\/?#]/)) {
		const decoded = segment.replace(/%[0-9a-f]{2}/gi, encoded => String.fromCharCode(Number.parseInt(encoded.slice(1), 16)))
		// Privacy checks deliberately include invalid suffixes containing a real token.
		const match = decoded.match(/(?:^|[\\/])(al_[A-Za-z0-9_-]{43})/)
		if (match) return match[1]
	}
	return undefined
}

export function hasGatewayCredential(value: string | undefined | null): boolean {
	return gatewayCredential(value) !== undefined
}

export function preservesGatewayCredential(supplied: string, pathname: string): boolean {
	const credential = gatewayCredential(supplied)
	return !credential || credential === gatewayCredential(pathname)
}

let telemetryShutdown: Promise<void> | undefined

/** Stop telemetry before a credential request, including concurrently starting probes. */
export function disableGatewayTelemetry(): Promise<void> {
	if (telemetryShutdown) return telemetryShutdown
	if (!window.SENTRY_ENABLED) return Promise.resolve()
	// Sticky for this page, even when the probe fails and restores an ordinary API URL.
	window.SENTRY_ENABLED = false
	telemetryShutdown = import('@sentry/vue').then(async Sentry => {
		const client = Sentry.getClient()
		if (client) client.getOptions().enabled = false
		await Sentry.getReplay()?.stop({flush: false})
		await client?.close(1)
	})
	return telemetryShutdown
}

export function restoreSavedApiUrl(): void {
	const saved = localStorage.getItem('API_URL')
	if (!isDesktopApp() && hasGatewayCredential(saved)) {
		localStorage.removeItem('API_URL')
	} else if (saved !== null && !getGatewayBaseUrl()) {
		window.API_URL = saved
	}
	const prefix = getGatewayBaseUrl()
	if (prefix) window.API_URL = new URL(prefix + 'api/v1', window.location.origin).href
}

export function saveApiUrl(value: string): void {
	if (isDesktopApp() || !hasGatewayCredential(value)) {
		localStorage.setItem('API_URL', value)
	} else if (hasGatewayCredential(localStorage.getItem('API_URL'))) {
		localStorage.removeItem('API_URL')
	}
}

export function usesGatewayCredential(): boolean {
	return Boolean(getGatewayBaseUrl()) || hasGatewayCredential(window.location.href) || hasGatewayCredential(window.API_URL)
}

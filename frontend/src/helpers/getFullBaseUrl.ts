/**
 * Get full BASE_URL
 * - including path
 * - will always end with a trailing slash 
 */
export function getGatewayBaseUrl(): string | undefined {
	// Service workers share this helper but have no window.
	if (typeof window === 'undefined') return undefined
	const credential = window.location.pathname.match(/^\/al_[A-Za-z0-9_-]{43}(?=\/|$)/)
	return credential ? credential[0] + '/' : undefined
}

export function getFullBaseUrl() {
	const gatewayBase = getGatewayBaseUrl()
	if (gatewayBase) return gatewayBase
	// (1) The injected BASE_URL is declared from the `resolvedBase` that might miss a trailing slash...
	// see: https://github.com/vitejs/vite/blob/b35fe883fdc699ac1450882562872095abe9959b/packages/vite/src/node/config.ts#LL614C25-L614C25
	const rawBase = import.meta.env.BASE_URL === './' ? '/' : import.meta.env.BASE_URL
	// (2) so we readd a slash like done here
	// https://github.com/vitejs/vite/blob/b35fe883fdc699ac1450882562872095abe9959b/packages/vite/src/node/config.ts#L643
	// See this comment: https://github.com/vitejs/vite/pull/10723#issuecomment-1303627478
	return rawBase.endsWith('/') ? rawBase : rawBase + '/'
}

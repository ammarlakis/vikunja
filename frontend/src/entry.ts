import {prepareGatewaySession} from './helpers/gatewaySession'

prepareGatewaySession()
	.then(ready => {
		if (ready) return import('./main')
	})
	.catch(() => {
		document.body.textContent = 'Unable to start Vikunja. Please reload the page.'
	})

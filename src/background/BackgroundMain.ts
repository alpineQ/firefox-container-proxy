import { Store } from '../store/Store'
import { HttpProxySettings, HttpsProxySettings, ProxySettings } from '../domain/ProxySettings'
import { ProxyInfo, Socks5ProxyInfo } from '../domain/ProxyInfo'
import { ProxyType } from '../domain/ProxyType'
import BlockingResponse = browser.webRequest.BlockingResponse
import _OnAuthRequiredDetails = browser.webRequest._OnAuthRequiredDetails
import _OnRequestDetails = browser.proxy._OnRequestDetails

const localhosts = new Set(['localhost', '127.0.0.1', '[::1]'])

const maxObservedHosts = 5

function extensionUuidFromUrl (url: string | undefined): string | null {
  if (url === undefined || url === '') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'moz-extension:') return parsed.hostname
  } catch (e) {}
  return null
}

type DoNotProxy = never[]
export const doNotProxy: DoNotProxy = []

const emergencyBreak: Socks5ProxyInfo = {
  type: ProxyType.Socks5,
  host: 'emergency-break-proxy.localhost',
  port: 1,
  failoverTimeout: 1,
  username: 'nonexistent user',
  password: 'dummy password',
  proxyDNS: true
}

export default class BackgroundMain {
  store: Store

  constructor ({ store }: { store: Store }) {
    this.store = store
  }

  async recordObservedExtension (uuid: string, requestUrl: string): Promise<void> {
    let host: string
    try {
      host = new URL(requestUrl).hostname
    } catch (e) {
      return
    }
    const observed = await this.store.getObservedExtensions()
    const entry = observed[uuid] ?? { hosts: [], lastSeen: 0 }
    const isNewHost = !entry.hosts.includes(host)
    if (isNewHost) {
      entry.hosts = [host, ...entry.hosts].slice(0, maxObservedHosts)
    }
    entry.lastSeen = Date.now()
    observed[uuid] = entry
    if (isNewHost) {
      await this.store.saveObservedExtensions(observed)
    }
  }

  private ownExtensionUuid (): string | null {
    try {
      return new URL(browser.runtime.getURL('')).hostname
    } catch (e) {
      return null
    }
  }

  initializeAuthListener (cookieStoreId: string, proxy: HttpProxySettings | HttpsProxySettings): void {
    const listener: (details: _OnAuthRequiredDetails) => BlockingResponse = (details) => {
      if (!details.isProxy) return {}

      if (details.cookieStoreId !== cookieStoreId) return {}

      // TODO: Fix in @types/firefox-webext-browser
      // @ts-expect-error
      const info = details.proxyInfo
      if (info.host !== proxy.host || info.port !== proxy.port || info.type !== proxy.type) return {}

      const result = { authCredentials: { username: proxy.username, password: proxy.password } }

      browser.webRequest.onAuthRequired.removeListener(listener)

      return result
    }

    browser.webRequest.onAuthRequired.addListener(
      listener,
      { urls: ['<all_urls>'] },
      ['blocking']
    )
  }

  openPreferences (browser: { runtime: any }) {
    return () => {
      browser.runtime.openOptionsPage()
    }
  }

  // TODO: Fix in @types/firefox-webext-browser
  async onRequest (requestDetails: Pick<_OnRequestDetails, 'cookieStoreId' | 'url'> & { originUrl?: string, documentUrl?: string }): Promise<DoNotProxy | ProxyInfo[]> {
    try {
      const extensionUuid = extensionUuidFromUrl(requestDetails.originUrl) ?? extensionUuidFromUrl(requestDetails.documentUrl)
      if (extensionUuid !== null && extensionUuid !== this.ownExtensionUuid()) {
        void this.recordObservedExtension(extensionUuid, requestDetails.url)
        const proxy = await this.store.getProxyForExtension(extensionUuid)
        if (proxy === null) {
          return doNotProxy
        }
        if (proxy.type === ProxyType.Http || proxy.type === ProxyType.Https) {
          this.initializeAuthListener(requestDetails.cookieStoreId ?? '', proxy)
        }
        return [proxy.asProxyInfo()]
      }

      const cookieStoreId = requestDetails.cookieStoreId ?? ''
      if (cookieStoreId === '') {
        console.error('cookieStoreId is not defined', requestDetails)
        return doNotProxy
      }

      const proxies = await this.store.getProxiesForContainer(cookieStoreId)

      if (proxies.length > 0) {
        proxies.forEach(p => {
          if (p.type === ProxyType.Http || p.type === ProxyType.Https) {
            this.initializeAuthListener(cookieStoreId, p)
          }
        })

        const result: ProxyInfo[] = proxies.filter((p: ProxySettings) => {
          try {
            const documentUrl = new URL(requestDetails.url)
            const isLocalhost = localhosts.has(documentUrl.hostname)
            if (isLocalhost && p.doNotProxyLocal) {
              return false
            }
          } catch (e) {
            console.error(e)
          }

          return true
        }).map(p => p.asProxyInfo())

        if (result.length === 0) {
          return doNotProxy
        }
        return result
      }

      return doNotProxy
    } catch (e: unknown) {
      console.error(`Error in onRequest listener: ${e as string}`)
      return [emergencyBreak]
    }
  }

  run (browser: { proxy: any, browserAction: any, runtime: any }): void {
    const filter = { urls: ['<all_urls>'] }

    browser.proxy.onRequest.addListener(this.onRequest.bind(this), filter)

    browser.browserAction.onClicked.addListener(this.openPreferences(browser))

    browser.proxy.onError.addListener((e: Error) => {
      console.error('Proxy error', e)
    })
  }
}

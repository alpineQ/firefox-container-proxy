import m, { Component, Vnode } from 'mithril'
import { ObservedExtensions, Store } from '../store/Store'
import { ProxySettings } from '../domain/ProxySettings'

class ExtensionListModel {
  proxies: ProxySettings[] = []
  relations: Map<string, string> = new Map<string, string>()
  observed: ObservedExtensions = {}

  async loadAll (): Promise<void> {
    const store: Store = (window as any).store
    this.proxies = await store.getAllProxies()
    this.relations = new Map<string, string>(Object.entries(await store.getExtensionRelations()))
    this.observed = await store.getObservedExtensions()
    m.redraw()
  }

  async saveRelations (): Promise<void> {
    await browser.storage.local.set({ extensionRelations: Object.fromEntries(this.relations) })
  }
}

export class ExtensionListView implements Component {
  model: ExtensionListModel = new ExtensionListModel()

  async oninit (): Promise<void> {
    await this.model.loadAll()
    m.redraw()
  }

  view (): Vnode {
    const uuids = Array.from(new Set([...Object.keys(this.model.observed), ...this.model.relations.keys()]))
    if (uuids.length === 0) {
      return m('.extensions', m('.extensions-empty', browser.i18n.getMessage('ExtensionList_empty')))
    }
    return m('.extensions', uuids.map((u) => this.renderExtensionItem(u)))
  }

  renderSelectProxy (uuid: string, proxyId: string): Vnode {
    const proxyOptions = this.model.proxies.map(p => m('option', {
      value: p.id,
      selected: p.id === proxyId
    }, p.title !== '' ? p.title : p.url))
    const defaultOption = m('option', {
      value: '',
      selected: proxyId === ''
    }, browser.i18n.getMessage('ContainerList_proxyDisabled'))
    return m(
      'select',
      {
        oninput: async (e: InputEvent): Promise<void> => {
          const selected = (e.target as HTMLSelectElement).value
          if (selected === '') {
            this.model.relations.delete(uuid)
          } else {
            this.model.relations.set(uuid, selected)
          }
          await this.model.saveRelations()
        }
      },
      [defaultOption, ...proxyOptions]
    )
  }

  renderExtensionItem (uuid: string): Vnode {
    const proxyId = this.model.relations.get(uuid) ?? ''
    const hosts = this.model.observed[uuid]?.hosts ?? []
    const hint = hosts.length > 0
      ? browser.i18n.getMessage('ExtensionList_recentHosts', hosts.join(', '))
      : ''
    return m('.container-item', [
      m('.container-label', [
        m('.extension-uuid', uuid),
        hint !== '' ? m('.extension-hosts', hint) : null
      ]),
      m('.attached-proxies', [
        this.renderSelectProxy(uuid, proxyId)
      ])
    ])
  }
}

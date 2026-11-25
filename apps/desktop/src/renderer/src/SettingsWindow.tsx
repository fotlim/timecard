import { useEffect, useRef, useState } from 'react'
import { SKINS, SKIN_LABELS, SKIN_TAGLINES } from '@timecard/shared'
import type { Skin } from '@timecard/shared'
import { useStore } from './store'
import type { AppInfo } from './env'

const PHASE_TEXT: Record<string, string> = {
  idle: '空闲',
  syncing: '同步中…',
  offline: '离线',
  error: '出错'
}

export function SettingsWindow(): React.JSX.Element {
  const store = useStore()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [confirm, setConfirm] = useState<'reset' | 'clear' | 'outbox' | null>(null)
  const [busy, setBusy] = useState(false)

  // 服务器地址 / 令牌先存在本地草稿里，点「保存」才真正落盘。
  // 边打字边保存的话，每敲一个字都会往半成品 URL 发请求。
  const [draftUrl, setDraftUrl] = useState('')
  const [draftToken, setDraftToken] = useState('')
  const [dirty, setDirty] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const settings = store.sync?.settings
  const st = store.sync?.state
  const rep = store.sync?.report

  // 主进程推来新配置时同步到草稿（但不要覆盖用户正在改的内容）
  const settingsKey = `${settings?.serverUrl ?? ''}|${settings?.token ?? ''}`
  const lastKey = useRef('')
  useEffect(() => {
    if (!settings) return
    if (lastKey.current === settingsKey && dirty) return
    if (!dirty) {
      setDraftUrl(settings.serverUrl)
      setDraftToken(settings.token)
      lastKey.current = settingsKey
    }
  }, [settings, settingsKey, dirty])

  useEffect(() => {
    void window.timecard?.info().then(setInfo)
  }, [])

  const cardCount = store.cards.filter((c) => c.deletedAt === null).length
  const enabled = !!settings?.enabled
  const configured = enabled && !!settings?.serverUrl.trim()
  const phase = st?.phase ?? 'idle'

  const saveConnection = async (): Promise<void> => {
    await window.timecard?.sync.setSettings({
      serverUrl: draftUrl.trim(),
      token: draftToken.trim()
    })
    setDirty(false)
    lastKey.current = `${draftUrl.trim()}|${draftToken.trim()}`
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    try {
      const r = await window.timecard?.sync.test(draftUrl, draftToken)
      if (!r) return
      setTest(
        r.ok
          ? {
              ok: true,
              text: `连接成功 · ${r.ms}ms · 服务器上 ${r.cardCount ?? 0} 张卡 · v${r.version ?? '?'}`
            }
          : { ok: false, text: r.message ?? '连接失败' }
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-shell">
      <header className="settings-titlebar">
        <span className="brand-row">
          <span className="branddot" />
          设置
        </span>
        <span className="settings-sub">挂卡时间轴</span>
      </header>

      <main className="settings-body">
        {/* ---------- 外观 ---------- */}
        <section className="sgroup">
          <h3>外观</h3>
          <div className="skin-grid">
            {SKINS.map((skin) => (
              <button
                key={skin}
                className={`skin-card${store.skin === skin ? ' on' : ''}`}
                onClick={() => store.setSkin(skin as Skin)}
              >
                <span className={`swatch sw-${skin}`} />
                <span className="skin-name">{SKIN_LABELS[skin]}</span>
                <span className="skin-desc">{SKIN_TAGLINES[skin]}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ---------- 浮窗 ---------- */}
        <section className="sgroup">
          <h3>浮窗</h3>
          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">全局快捷键</span>
              <span className="srow-desc">任何界面按一下，呼出/收起浮窗</span>
            </div>
            {info && info.quickShortcutRegistered === false ? (
              <span className="skbd-wrap">
                <kbd className="skbd off">{info.quickAccelerator}</kbd>
                <span className="skbd-warn">被其它程序占用，按下无反应</span>
              </span>
            ) : (
              <kbd className="skbd">{info?.quickAccelerator ?? 'Ctrl+Shift+Space'}</kbd>
            )}
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">浮窗位置</span>
              <span className="srow-desc">
                拖动面板顶部的把手可以移动，置顶在所有窗口之上
              </span>
            </div>
            <button className="sbtn" onClick={() => void window.timecard?.quick.resetPosition()}>
              回到屏幕中间
            </button>
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">打开浮窗</span>
            </div>
            <button className="sbtn" onClick={() => void window.timecard?.quick.show()}>
              现在打开
            </button>
          </div>
        </section>

        {/* ---------- 同步 ---------- */}
        <section className="sgroup">
          <h3>同步</h3>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">启用同步</span>
              <span className="srow-desc">本地先写，断网照常能挂卡；联网后自动推上去</span>
            </div>
            <button
              className={`stoggle${enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={enabled}
              onClick={() => void window.timecard?.sync.setSettings({ enabled: !enabled })}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">服务器地址</span>
              <span className="srow-desc">例如 http://127.0.0.1:8787</span>
            </div>
          </div>
          <div className="srow">
            <input
              className="sinput"
              type="text"
              spellCheck={false}
              placeholder="https://你的服务器"
              value={draftUrl}
              onChange={(e) => {
                setDraftUrl(e.target.value)
                setDirty(true)
                setTest(null)
              }}
            />
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">访问令牌</span>
              <span className="srow-desc">服务器那边设的 TIMECARD_TOKEN</span>
            </div>
          </div>
          <div className="srow">
            <input
              className="sinput"
              type="password"
              spellCheck={false}
              placeholder="Bearer token"
              value={draftToken}
              onChange={(e) => {
                setDraftToken(e.target.value)
                setDirty(true)
                setTest(null)
              }}
            />
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-desc">
                先测一下再保存 —— 地址或令牌不对，这里就能看出来
              </span>
            </div>
            <span className="sconfirm">
              <button className="sbtn" disabled={testing} onClick={() => void runTest()}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {dirty && (
                <button className="sbtn primary" onClick={() => void saveConnection()}>
                  保存
                </button>
              )}
            </span>
          </div>

          {test && (
            <div className="srow">
              <div className="srow-main">
                <span className={`srow-desc ${test.ok ? 'sync-ok' : 'sync-err'}`}>
                  {test.ok ? '✓ ' : '✗ '}
                  {test.text}
                </span>
              </div>
            </div>
          )}

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">
                <span className={`sync-dot ${phase}`} />
                {PHASE_TEXT[phase] ?? phase}
                {st && st.pending > 0 ? ` · ${st.pending} 条待推送` : ''}
              </span>
              <span className="srow-desc">
                {st?.lastSyncAt
                  ? `上次同步 ${new Date(st.lastSyncAt).toLocaleTimeString()}`
                  : '还没同步过'}
              </span>
            </div>
            <button
              className="sbtn"
              disabled={busy || !configured || dirty}
              onClick={() => {
                setBusy(true)
                void window.timecard?.sync.now().finally(() => setBusy(false))
              }}
            >
              {busy || phase === 'syncing' ? '同步中…' : '立即同步'}
            </button>
          </div>

          {st?.error && (
            <div className="srow">
              <div className="srow-main">
                <span className="srow-desc sync-err">{st.error}</span>
              </div>
            </div>
          )}

          {rep && rep.ok && (
            <div className="srow">
              <div className="srow-main">
                <span className="srow-desc">
                  上次结果：推上去 {rep.pushed} 条，拉下来 {rep.pulled} 条
                  {rep.conflicts.length > 0
                    ? `，${rep.conflicts.length} 张被服务器版本覆盖`
                    : ''}
                </span>
              </div>
            </div>
          )}

          {rep && rep.conflicts.length > 0 && (
            <div className="srow sync-conflicts">
              <div className="srow-main">
                <span className="srow-title">本轮冲突（已采用服务器版本）</span>
                {rep.conflicts.slice(0, 5).map((c) => (
                  <span key={c.id} className="srow-desc">
                    「{c.serverCard.title}」
                  </span>
                ))}
                {rep.conflicts.length > 5 && (
                  <span className="srow-desc">…还有 {rep.conflicts.length - 5} 张</span>
                )}
              </div>
            </div>
          )}

          {(st?.pending ?? 0) > 0 && (
            <div className="srow">
              <div className="srow-main">
                <span className="srow-title">清空待推送队列</span>
                <span className="srow-desc">换服务器或不想再推这些改动时用</span>
              </div>
              {confirm === 'outbox' ? (
                <span className="sconfirm">
                  <span>确定清空？</span>
                  <button
                    className="sbtn danger"
                    onClick={() => {
                      setConfirm(null)
                      void window.timecard?.sync.clearOutbox()
                    }}
                  >
                    确定清空
                  </button>
                  <button className="sbtn" onClick={() => setConfirm(null)}>
                    取消
                  </button>
                </span>
              ) : (
                <button className="sbtn danger" onClick={() => setConfirm('outbox')}>
                  清空
                </button>
              )}
            </div>
          )}
        </section>

        {/* ---------- 行为 ---------- */}
        <section className="sgroup">
          <h3>行为</h3>
          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">关闭窗口时最小化到托盘</span>
              <span className="srow-desc">关掉后点 ✕ 会直接退出应用</span>
            </div>
            <button
              className={`stoggle${store.prefs.closeToTray ? ' on' : ''}`}
              role="switch"
              aria-checked={store.prefs.closeToTray}
              onClick={() => store.setPrefs({ closeToTray: !store.prefs.closeToTray })}
            >
              <span className="knob" />
            </button>
          </div>
        </section>

        {/* ---------- 数据 ---------- */}
        <section className="sgroup">
          <h3>数据</h3>
          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">当前卡片</span>
              <span className="srow-desc">{cardCount} 张（不含已删除）</span>
            </div>
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">数据文件</span>
              <span className="srow-desc srow-path">{info?.dataFile ?? '…'}</span>
            </div>
            <button className="sbtn" onClick={() => void window.timecard?.openDataFolder()}>
              打开文件夹
            </button>
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">重置演示数据</span>
              <span className="srow-desc">恢复成一开始那几张示例卡</span>
            </div>
            {confirm === 'reset' ? (
              <span className="sconfirm">
                <button
                  className="sbtn danger"
                  onClick={() => {
                    store.resetAll()
                    setConfirm(null)
                  }}
                >
                  确定重置
                </button>
                <button className="sbtn" onClick={() => setConfirm(null)}>
                  取消
                </button>
              </span>
            ) : (
              <button className="sbtn" onClick={() => setConfirm('reset')}>
                重置
              </button>
            )}
          </div>

          <div className="srow">
            <div className="srow-main">
              <span className="srow-title">清空全部卡片</span>
              <span className="srow-desc">卡片会真的删掉，不做回收站</span>
            </div>
            {confirm === 'clear' ? (
              <span className="sconfirm">
                <button
                  className="sbtn danger"
                  onClick={() => {
                    store.clearAll()
                    setConfirm(null)
                  }}
                >
                  确定清空
                </button>
                <button className="sbtn" onClick={() => setConfirm(null)}>
                  取消
                </button>
              </span>
            ) : (
              <button className="sbtn" onClick={() => setConfirm('clear')}>
                清空
              </button>
            )}
          </div>
        </section>

        {/* ---------- 关于 ---------- */}
        <section className="sgroup">
          <h3>关于</h3>
          <div className="sgrid">
            <span>版本</span>
            <b>{info?.version ?? '—'}</b>
            <span>Electron</span>
            <b>{info?.electron ?? '—'}</b>
            <span>Chromium</span>
            <b>{info?.chrome ?? '—'}</b>
            <span>Node</span>
            <b>{info?.node ?? '—'}</b>
          </div>
          <p className="sfoot">把要做的事，挂在时间上。</p>
        </section>
      </main>
    </div>
  )
}

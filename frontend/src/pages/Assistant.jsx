import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat } from '../api.js';
import { getMeta } from '../startup.js';
import { Block } from '../components/Blocks.jsx';
import { Icon, Mark } from '../components/Icon.jsx';
import { CopyButton, ErrorState, RichText } from '../components/ui.jsx';
import { relativeTime } from '../format.js';

const STARTERS = [
  { title: 'Balances', prompt: "What's my balance?" },
  { title: 'This month', prompt: 'How much did I spend this month?' },
  { title: 'Compare', prompt: 'Compare my spending with last month' },
  { title: 'Why it changed', prompt: 'Why did my expenses increase this month?' },
  { title: 'Subscriptions', prompt: 'Which subscriptions am I paying for?' },
  { title: 'Saving', prompt: 'How much money can I safely save this month?' },
  { title: 'Send money', prompt: 'Send ₹2,000 to Rahul' },
  { title: 'A problem', prompt: 'My UPI payment failed but I think money was deducted' }
];

function splitSuggestions(blocks = []) {
  const s = blocks.find((b) => b.type === 'suggestions');
  return { blocks: blocks.filter((b) => b.type !== 'suggestions'), suggestions: s?.items ?? [] };
}

function fromServer(m) {
  const { blocks, suggestions } = splitSuggestions(m.blocks);
  return { id: m.id, role: m.role, content: m.content, blocks, suggestions, tools: (m.tools ?? []).map((t) => ({ ...t, running: false })), state: 'done' };
}

export function Assistant({ user, initialPrompt, onConsumePrompt, onDataChanged }) {
  const [meta, setMeta] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const forceScrollRef = useRef(false);
  const inputRef = useRef(null);
  const convRef = useRef(null);
  const busyRef = useRef(false);
  const sentPromptRef = useRef(null);
  convRef.current = conversationId;

  const refreshList = useCallback(() => api('/conversations').then((r) => setConversations(r.items)).catch(() => {}), []);
  useEffect(() => {
    getMeta().then(setMeta).catch(() => setMeta({ assistantMode: 'unknown' }));
    refreshList();
  }, [refreshList]);

  // Stay pinned to the newest message while the user is at the bottom; leave them alone if they scroll up.
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => { stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    // Content can grow after render (streamed text, charts measuring their width), so watch the DOM.
    const observer = new MutationObserver(() => { if (stickRef.current) el.scrollTop = el.scrollHeight; });
    el.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { el.removeEventListener('scroll', onScroll); observer.disconnect(); };
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceScrollRef.current) stickRef.current = true;
    forceScrollRef.current = false;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!busy) return undefined;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const patchLast = (fn) => setMessages((ms) => {
    const copy = [...ms];
    copy[copy.length - 1] = fn(copy[copy.length - 1]);
    return copy;
  });

  const send = useCallback(async (raw) => {
    const text = String(raw ?? '').trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    forceScrollRef.current = true;
    setInput('');
    setBusy(true);
    setMessages((ms) => [...ms, { id: `local-${Date.now()}`, role: 'user', content: text, blocks: [], tools: [], state: 'done' },
      { id: `pending-${Date.now()}`, role: 'assistant', content: '', blocks: [], tools: [], suggestions: [], state: 'streaming', statusText: '' }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat({
        message: text,
        conversationId: convRef.current,
        signal: controller.signal,
        onEvent: (event, data) => {
          if (event === 'meta') {
            setConversationId(data.conversationId);
            convRef.current = data.conversationId;
          } else if (event === 'tool_start') patchLast((m) => ({ ...m, tools: [...m.tools, { name: data.name, label: data.label, running: true }], statusText: '' }));
          else if (event === 'tool_end') patchLast((m) => ({ ...m, tools: m.tools.map((t) => (t.name === data.name && t.running ? { ...t, running: false, status: data.status } : t)) }));
          else if (event === 'block') patchLast((m) => ({ ...m, blocks: [...m.blocks, data] }));
          else if (event === 'text') patchLast((m) => ({ ...m, content: m.content + data.delta, statusText: '' }));
          else if (event === 'status') patchLast((m) => ({ ...m, statusText: data.message }));
          else if (event === 'error') patchLast((m) => ({ ...m, errorText: data.message }));
          else if (event === 'done') {
            const { blocks, suggestions } = splitSuggestions(data.message.blocks);
            patchLast((m) => ({ ...m, id: data.message.id, content: data.message.content, blocks: blocks.length ? blocks : m.blocks, suggestions: data.message.suggestions ?? suggestions, state: m.errorText ? 'error' : 'done', statusText: '' }));
          }
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') patchLast((m) => ({ ...m, state: 'done', statusText: '', content: m.content || 'Stopped.' }));
      else patchLast((m) => ({ ...m, state: 'error', errorText: error.message, statusText: '' }));
    } finally {
      busyRef.current = false;
      setBusy(false);
      abortRef.current = null;
      refreshList();
      onDataChanged?.();
      inputRef.current?.focus();
    }
  }, [refreshList, onDataChanged]);

  useEffect(() => {
    if (!initialPrompt) { sentPromptRef.current = null; return; }
    if (sentPromptRef.current === initialPrompt || busyRef.current) return;
    sentPromptRef.current = initialPrompt;
    {
      onConsumePrompt?.();
      setConversationId(null);
      convRef.current = null;
      setMessages([]);
      send(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  async function openConversation(id) {
    if (busy) return;
    setShowHistory(false);
    setLoadError(null);
    try {
      const c = await api(`/conversations/${id}`);
      setConversationId(c.id);
      forceScrollRef.current = true;
      setMessages(c.messages.map(fromServer));
    } catch (e) {
      setLoadError(e);
    }
  }

  async function removeConversation(id) {
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' });
      if (id === conversationId) newConversation();
      refreshList();
    } catch (e) {
      setLoadError(e);
    }
  }

  function newConversation() {
    if (busy) return;
    setConversationId(null);
    setMessages([]);
    setShowHistory(false);
    inputRef.current?.focus();
  }

  const onActionResolved = (res) => {
    if (res?.message) setMessages((ms) => [...ms, fromServer(res.message)]);
    onDataChanged?.();
  };
  const ctx = { today: meta?.today ?? new Date().toISOString().slice(0, 10), onSend: send, onActionResolved, busy, readOnly: user.role === 'viewer' };
  const last = messages.at(-1);

  return (
    <div className="assistant">
      <aside className={`history ${showHistory ? 'open' : ''}`} aria-label="Conversation history">
        <button className="btn btn-primary btn-block" onClick={newConversation} disabled={busy}><Icon name="plus" size={16} />New conversation</button>
        <h2 className="history-title">Recent</h2>
        {conversations.length === 0 && <p className="muted small">Your conversations will appear here.</p>}
        <ul>
          {conversations.map((c) => (
            <li key={c.id} className={c.id === conversationId ? 'active' : ''}>
              <button className="history-item" onClick={() => openConversation(c.id)} disabled={busy}>
                <span>{c.title}</span><small>{relativeTime(c.updatedAt)}</small>
              </button>
              <button className="icon-btn" onClick={() => removeConversation(c.id)} aria-label={`Delete conversation ${c.title}`} disabled={busy}><Icon name="trash" size={15} /></button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat">
        <header className="chat-head">
          <button className="icon-btn history-toggle" onClick={() => setShowHistory((v) => !v)} aria-label="Show conversation history"><Icon name="menu" /></button>
          <div>
            <h1>Assistant</h1>
            <p className="muted small">{meta?.assistantMode === 'gemini' ? `Powered by Gemini (${meta.model})` : meta?.assistantMode === 'demo' ? 'Demo mode: keyword routing without Gemini' : 'Connecting…'}</p>
          </div>
          <span className="secure-note"><Icon name="lock" size={14} />Never share your PIN, OTP or password</span>
        </header>

        <div className="chat-scroll" ref={scrollRef} role="log" aria-label="Conversation" tabIndex={0}>
          {loadError && <ErrorState error={loadError} />}
          {messages.length === 0 && (
            <div className="chat-empty">
              <Mark size={44} />
              <h2>What would you like to know, {user.firstName}?</h2>
              <p className="muted">I can explain your spending, find transactions, prepare payments for your approval and help with problems.</p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s.prompt} className="starter" onClick={() => send(s.prompt)} disabled={busy}>
                    <strong>{s.title}</strong><span>{s.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, idx) => (m.role === 'user' ? (
            <div key={m.id} className="msg msg-user"><div className="bubble">{m.content}</div></div>
          ) : (
            <div key={m.id} className="msg msg-assistant">
              <span className="msg-avatar"><Mark size={28} /></span>
              <div className="msg-body">
                {m.tools.length > 0 && (
                  <ul className="tool-trail" aria-label="Steps taken">
                    {m.tools.map((t, i) => (
                      <li key={`${t.name}-${i}`} className={t.running ? 'running' : t.status === 'error' ? 'err' : ''}>
                        {t.running ? <span className="spinner" aria-hidden="true" /> : <Icon name={t.status === 'error' ? 'alert' : 'check'} size={13} />}
                        {t.label}
                      </li>
                    ))}
                  </ul>
                )}
                {m.blocks.map((b, i) => <Block key={`${m.id}-b${i}`} block={b} ctx={ctx} />)}
                {m.content && <RichText text={m.content} />}
                {m.state === 'streaming' && !m.content && (
                  <p className="thinking"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{m.statusText || (m.tools.some((t) => t.running) ? 'Working…' : 'Thinking…')}{elapsed >= 5 && <span className="muted small"> {elapsed}s</span>}</p>
                )}
                {m.errorText && m.errorText !== m.content && <p className="inline-error" role="alert">{m.errorText}</p>}
                {m.state !== 'streaming' && m.content && (
                  <div className="msg-actions">
                    <CopyButton text={m.content} />
                    {m.state === 'error' && idx === messages.length - 1 && messages[idx - 1]?.role === 'user' && <button className="link-btn" onClick={() => send(messages[idx - 1].content)}>Try again</button>}
                  </div>
                )}
                {m === last && m.state === 'done' && m.suggestions?.length > 0 && (
                  <div className="followups" role="group" aria-label="Suggested follow-ups">
                    {m.suggestions.map((s) => <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>{s}</button>)}
                  </div>
                )}
              </div>
            </div>
          )))}
        </div>

        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            maxLength={2000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Ask about your money, or say what you'd like to do"
            aria-label="Message the assistant"
          />
          {busy ? (
            <button type="button" className="send-btn stop" onClick={() => abortRef.current?.abort()} aria-label="Stop generating"><Icon name="stop" /></button>
          ) : (
            <button type="submit" className="send-btn" disabled={!input.trim()} aria-label="Send message"><Icon name="arrowUp" /></button>
          )}
        </form>
        <p className="composer-note">Payments and card changes always need your approval on a card. Simulated bank: no real money moves.</p>
      </section>
    </div>
  );
}

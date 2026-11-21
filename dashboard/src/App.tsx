import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  loadSession,
  money,
  saveSession,
  when,
  type Break,
  type DeadEvent,
  type FlaggedPayout,
  type Resolution,
  type Run,
  type Session,
  type StuckPayout,
  type Summary,
  type Trace,
} from "./api";

const SOURCE_LABEL: Record<Run["source"], string> = { mock_bank: "Mock bank", stripe: "Stripe" };
const CLASS_LABEL: Record<string, string> = {
  missing_at_provider: "Missing at provider",
  missing_in_ledger: "Missing in ledger",
  amount_mismatch: "Amount mismatch",
  status_mismatch: "Status mismatch",
};

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  if (!session) {
    return (
      <SignIn
        onSignIn={(s) => {
          saveSession(s);
          setSession(s);
        }}
      />
    );
  }
  return (
    <Dashboard
      session={session}
      onSignOut={() => {
        saveSession(null);
        setSession(null);
      }}
    />
  );
}

function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api({ token, name }, "GET", "/summary");
      onSignIn({ token, name: name.trim() });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="signin">
      <form onSubmit={submit} className="card">
        <h1>Reconciliation admin</h1>
        <p className="muted">Every decision you make here is kept with your name, and any money it moves is posted to the ledger as a new transfer.</p>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </label>
        <label>
          Admin token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}

interface Data {
  summary: Summary;
  breaks: Break[];
  flagged: FlaggedPayout[];
  stuck: StuckPayout[];
  dead: DeadEvent[];
  resolutions: Resolution[];
  runs: Run[];
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [summary, breaks, flagged, dead, resolutions, runs] = await Promise.all([
        api<Summary>(session, "GET", "/summary"),
        api<{ data: Break[] }>(session, "GET", "/reconciliation/breaks?include_resolved=true"),
        api<{ flagged: FlaggedPayout[]; stuck: StuckPayout[] }>(session, "GET", "/payouts/flagged"),
        api<{ data: DeadEvent[] }>(session, "GET", "/outbox/dead"),
        api<{ data: Resolution[] }>(session, "GET", "/resolutions"),
        api<{ data: Run[] }>(session, "GET", "/reconciliation/runs?limit=10"),
      ]);
      setData({
        summary,
        breaks: breaks.data,
        flagged: flagged.flagged,
        stuck: flagged.stuck,
        dead: dead.data,
        resolutions: resolutions.data,
        runs: runs.data,
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Reconciliation</h1>
        <div className="row">
          <span className="muted">Signed in as {session.name}</span>
          <button className="ghost" onClick={() => void refresh()}>
            Refresh
          </button>
          <button className="ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      {error && <p className="error banner">{error}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <section className="tiles">
            <Tile label="Open breaks" value={data.summary.open_breaks} alert={data.summary.open_breaks > 0} />
            <Tile label="In transit" value={data.summary.in_transit} />
            <Tile label="Flagged payouts" value={data.summary.flagged_payouts} alert={data.summary.flagged_payouts > 0} />
            <Tile label="Payouts held over 1h" value={data.summary.stuck_payouts} />
            <Tile label="Dead outbox events" value={data.summary.dead_events} alert={data.summary.dead_events > 0} />
          </section>
          <RunPanel session={session} data={data} onDone={refresh} />
          <BreaksPanel session={session} breaks={data.breaks} onDone={refresh} onTrace={setTrace} />
          <FlaggedPanel session={session} flagged={data.flagged} stuck={data.stuck} onDone={refresh} onTrace={setTrace} />
          <DeadPanel session={session} dead={data.dead} onDone={refresh} />
          <ResolutionsPanel resolutions={data.resolutions} onTrace={setTrace} />
          <AccountsPanel accounts={data.summary.control_accounts} />
        </>
      )}
      {trace && <TraceDrawer session={session} breakKey={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}

function Tile({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className={`tile ${alert ? "alert" : ""}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <div className="panel-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function useAction(onDone: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Proof({ run }: { run: Run }) {
  if (run.status !== "completed" || !run.totals) return <span className={`badge ${run.status}`}>{run.status}</span>;
  const dims = Object.entries(run.totals);
  const ok = dims.every(([, p]) => p?.balanced);
  return (
    <span className={`badge ${ok ? "ok" : "bad"}`} title={dims.map(([k, p]) => `${k}: ledger ${p!.ledger_cents}, provider ${p!.provider_cents}, explained ${p!.explained_cents}, unexplained ${p!.unattributed_cents}`).join("\n")}>
      {ok ? "ties out" : "does not tie out"}
    </span>
  );
}

function RunPanel({ session, data, onDone }: { session: Session; data: Data; onDone: () => Promise<void> }) {
  const [source, setSource] = useState<Run["source"]>("mock_bank");
  const [currency, setCurrency] = useState("USD");
  const { busy, error, run } = useAction(onDone);
  const start = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api(session, "POST", "/reconciliation/runs", { source, currency }));
  };
  return (
    <Panel
      title="Runs"
      aside={
        <form className="row" onSubmit={start}>
          <select value={source} onChange={(e) => setSource(e.target.value as Run["source"])}>
            <option value="mock_bank" disabled={!data.summary.providers.mock_bank}>
              Mock bank
            </option>
            <option value="stripe" disabled={!data.summary.providers.stripe}>
              Stripe
            </option>
          </select>
          <input className="currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          <button type="submit" disabled={busy}>
            {busy ? "Running…" : "Run reconciliation"}
          </button>
        </form>
      }
    >
      {error && <p className="error">{error}</p>}
      <p className="muted">
        A run reads the provider's whole statement, compares it with the ledger item by item, and checks that the ledger total minus the
        provider total equals what the remaining breaks explain, with nothing left unexplained.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Source</th>
              <th>Records</th>
              <th>Matched</th>
              <th>Auto-resolved</th>
              <th>In transit</th>
              <th>Open</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td>{when(r.started_at)}</td>
                <td>
                  {SOURCE_LABEL[r.source]} · {r.currency}
                </td>
                <td>{r.provider_records ?? "–"}</td>
                <td>{r.matched ?? "–"}</td>
                <td>{r.auto_resolved ?? "–"}</td>
                <td>{r.in_transit ?? "–"}</td>
                <td>{r.open_breaks ?? "–"}</td>
                <td>
                  <Proof run={r} />
                  {r.error && <div className="error small">{r.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Position({ held, settled, currency, source }: { held: number; settled: number; currency: string; source: Run["source"] }) {
  return (
    <div className="position">
      {source === "mock_bank" && <div>in flight {money(held, currency)}</div>}
      <div>
        {source === "mock_bank" ? "paid out" : "collected"} {money(settled, currency)}
      </div>
    </div>
  );
}

function BreaksPanel({
  session,
  breaks,
  onDone,
  onTrace,
}: {
  session: Session;
  breaks: Break[];
  onDone: () => Promise<void>;
  onTrace: (k: string) => void;
}) {
  const open = breaks.filter((b) => b.outcome === "open" && !b.resolution);
  const transit = breaks.filter((b) => b.outcome === "in_transit");
  const resolved = breaks.filter((b) => b.resolution);
  return (
    <Panel title={`Unmatched items (${open.length} open)`}>
      {open.length === 0 && <p className="muted">Nothing needs a decision. The latest runs matched every item, or fixed it from the provider's record.</p>}
      {open.map((b) => (
        <BreakRow key={b.id} session={session} b={b} onDone={onDone} onTrace={onTrace} />
      ))}
      {transit.length > 0 && (
        <>
          <h3>In transit</h3>
          <p className="muted">Held by us and not yet at the bank, with a send still scheduled. Not failed on a guess; nothing to decide.</p>
          {transit.map((b) => (
            <BreakRow key={b.id} session={session} b={b} onDone={onDone} onTrace={onTrace} />
          ))}
        </>
      )}
      {resolved.length > 0 && (
        <>
          <h3>Resolved from the latest runs</h3>
          {resolved.map((b) => (
            <BreakRow key={b.id} session={session} b={b} onDone={onDone} onTrace={onTrace} />
          ))}
        </>
      )}
    </Panel>
  );
}

function BreakRow({ session, b, onDone, onTrace }: { session: Session; b: Break; onDone: () => Promise<void>; onTrace: (k: string) => void }) {
  const [choice, setChoice] = useState<string>(b.account_id ? "accept_provider:user" : "accept_provider:platform");
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const [action, counterparty] = choice.split(":");
    void run(() =>
      api(session, "POST", `/reconciliation/items/${b.id}/resolve`, {
        action,
        ...(counterparty ? { counterparty } : {}),
        note,
        resolved_by: session.name,
      }),
    );
  };
  return (
    <article className={`break ${b.resolution ? "resolved" : b.outcome}`}>
      <div className="break-head">
        <span className="badge">{CLASS_LABEL[b.classification] ?? b.classification}</span>
        <span className="muted">
          {SOURCE_LABEL[b.source]} · {b.currency}
        </span>
        <button className="link" onClick={() => onTrace(b.break_key)}>
          {b.break_key}
        </button>
      </div>
      <p>{b.detail}</p>
      <div className="compare">
        <div>
          <div className="muted small">Our ledger ({b.our_status ?? "no record"})</div>
          <Position held={b.ledger_held_cents} settled={b.ledger_settled_cents} currency={b.currency} source={b.source} />
        </div>
        <div>
          <div className="muted small">{SOURCE_LABEL[b.source]} ({b.provider_status ?? "no record"})</div>
          <Position held={b.provider_held_cents} settled={b.provider_settled_cents} currency={b.currency} source={b.source} />
        </div>
      </div>
      {b.auto_action && <p className="muted small">Done automatically: {b.auto_action}</p>}
      {b.resolution ? (
        <p className="resolved">
          Resolved by {b.resolution.resolved_by}: {b.resolution.action.replace("_", " ")}
          {b.resolution.counterparty ? ` (${b.resolution.counterparty})` : ""}. “{b.resolution.note}”
        </p>
      ) : (
        b.outcome === "open" && (
          <form className="resolve" onSubmit={submit}>
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {b.account_id && <option value="accept_provider:user">Provider is right: settle with the user's account</option>}
              <option value="accept_provider:platform">Provider is right: the platform absorbs the difference</option>
              <option value="accept_ours">Our ledger is right: move no money</option>
            </select>
            <input placeholder="Why (required, kept with the decision)" value={note} onChange={(e) => setNote(e.target.value)} minLength={3} required />
            <button type="submit" disabled={busy}>
              {busy ? "Posting…" : "Resolve"}
            </button>
            {error && <p className="error">{error}</p>}
          </form>
        )
      )}
    </article>
  );
}

function FlaggedPanel({
  session,
  flagged,
  stuck,
  onDone,
  onTrace,
}: {
  session: Session;
  flagged: FlaggedPayout[];
  stuck: StuckPayout[];
  onDone: () => Promise<void>;
  onTrace: (k: string) => void;
}) {
  return (
    <Panel title="Flagged payouts">
      <p className="muted">
        Payouts the bank contradicted. No money moved when they were flagged. If the money disagrees, a run lists it above as a break;
        acknowledging a flag here records that someone looked, and moves nothing.
      </p>
      {flagged.length === 0 && <p className="muted">None.</p>}
      {flagged.map((f) => (
        <FlagRow key={f.id} session={session} f={f} onDone={onDone} onTrace={onTrace} />
      ))}
      <h3>Held for over an hour</h3>
      {stuck.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="plain">
          {stuck.map((s) => (
            <li key={s.id}>
              <button className="link" onClick={() => onTrace(`payout:${s.id}`)}>
                {s.id}
              </button>{" "}
              {money(s.amount_cents, s.currency)} · {s.status} since {when(s.created_at)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FlagRow({ session, f, onDone, onTrace }: { session: Session; f: FlaggedPayout; onDone: () => Promise<void>; onTrace: (k: string) => void }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction(onDone);
  return (
    <article className={`break ${f.acknowledged ? "" : "open"}`}>
      <div className="break-head">
        <span className="badge">{f.status}</span>
        <span>{money(f.amount_cents, f.currency)}</span>
        <button className="link" onClick={() => onTrace(`payout:${f.id}`)}>
          payout:{f.id}
        </button>
      </div>
      <pre className="notes">{f.discrepancy}</pre>
      {f.acknowledged ? (
        <p className="resolved">
          Acknowledged by {f.acknowledged.resolved_by}: “{f.acknowledged.note}”
        </p>
      ) : (
        <form
          className="resolve"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api(session, "POST", `/payouts/${f.id}/acknowledge`, { note, resolved_by: session.name }));
          }}
        >
          <input placeholder="What you checked (required)" value={note} onChange={(e) => setNote(e.target.value)} minLength={3} required />
          <button type="submit" disabled={busy}>
            Acknowledge
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </article>
  );
}

function DeadPanel({ session, dead, onDone }: { session: Session; dead: DeadEvent[]; onDone: () => Promise<void> }) {
  const { busy, error, run } = useAction(onDone);
  return (
    <Panel title="Dead outbox events">
      <p className="muted">Events that ran out of retries. Re-queueing a payout submit is safe: the bank sees the same idempotency key.</p>
      {error && <p className="error">{error}</p>}
      {dead.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>For</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dead.map((d) => (
                <tr key={d.event_id}>
                  <td>{d.event_type}</td>
                  <td className="mono small">
                    {d.aggregate_type}:{d.aggregate_id}
                  </td>
                  <td>{d.attempts}</td>
                  <td className="small">{d.last_error}</td>
                  <td>
                    <button disabled={busy} onClick={() => void run(() => api(session, "POST", `/outbox/${d.event_id}/requeue`))}>
                      Re-queue
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ResolutionsPanel({ resolutions, onTrace }: { resolutions: Resolution[]; onTrace: (k: string) => void }) {
  return (
    <Panel title="Audit log">
      {resolutions.length === 0 ? (
        <p className="muted">No decisions yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Decision</th>
                <th>Item</th>
                <th>Ledger transfers</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {resolutions.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.created_at)}</td>
                  <td>{r.resolved_by}</td>
                  <td>
                    {r.action.replaceAll("_", " ")}
                    {r.counterparty ? ` (${r.counterparty})` : ""}
                  </td>
                  <td>
                    <button className="link" onClick={() => onTrace(r.break_key)}>
                      {r.break_key}
                    </button>
                  </td>
                  <td className="mono small">{r.transfer_ids.length ? r.transfer_ids.map((t) => t.slice(0, 8)).join(", ") : "none"}</td>
                  <td>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AccountsPanel({ accounts }: { accounts: Summary["control_accounts"] }) {
  return (
    <Panel title="Control accounts">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="num">{money(a.balance_cents, a.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TraceDrawer({ session, breakKey, onClose }: { session: Session; breakKey: string; onClose: () => void }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Trace>(session, "GET", `/reconciliation/trace?break_key=${encodeURIComponent(breakKey)}`).then(setTrace, (e: Error) => setError(e.message));
  }, [session, breakKey]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Where the money went</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mono small">{breakKey}</p>
        {error && <p className="error">{error}</p>}
        {trace && (
          <>
            <h3>Ledger transfers</h3>
            {trace.transfers.length === 0 && <p className="muted">None.</p>}
            {trace.transfers.map((t) => (
              <div key={t.id} className="transfer">
                <div className="row spread">
                  <span className="mono small">{t.idempotency_key}</span>
                  <span className="muted small">{when(t.created_at)}</span>
                </div>
                {t.entries.map((e, i) => (
                  <div key={i} className="row spread small">
                    <span>{e.account}</span>
                    <span className={`num ${e.amount_cents < 0 ? "neg" : ""}`}>{money(e.amount_cents, t.currency)}</span>
                  </div>
                ))}
              </div>
            ))}
            <h3>Runs that looked at it</h3>
            {trace.items.length === 0 && <p className="muted">Always matched.</p>}
            <ul className="plain">
              {trace.items.map((i) => (
                <li key={i.id} className="small">
                  {when(i.created_at)} · {CLASS_LABEL[i.classification]} · {i.outcome}
                  {i.auto_action ? ` · ${i.auto_action}` : ""}
                </li>
              ))}
            </ul>
            <h3>Decisions</h3>
            {trace.resolutions.length === 0 && <p className="muted">None.</p>}
            <ul className="plain">
              {trace.resolutions.map((r) => (
                <li key={r.id} className="small">
                  {when(r.created_at)} · {r.resolved_by} · {r.action.replaceAll("_", " ")} · “{r.note}”
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

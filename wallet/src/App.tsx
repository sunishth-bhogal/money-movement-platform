import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  get,
  isUnknownOutcome,
  loadSession,
  money,
  request,
  saveSession,
  when,
  type ActivityItem,
  type ActivityState,
  type Balances,
  type BankBehaviour,
  type Config,
  type DemoUser,
  type Response,
  type Session,
  type StatementLine,
  type WriteResult,
} from "./api";
import { describeAttempts, Draft, parseAmount, type Attempts } from "./idempotent";

const POLL_MS = 2000;

function useUrlParam(name: string): string | null {
  return useMemo(() => new URLSearchParams(window.location.search).get(name), [name]);
}

function clearUrl() {
  window.history.replaceState(null, "", window.location.pathname);
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(loadSession);
  const checkoutId = useUrlParam("demo_checkout");

  useEffect(() => {
    get<Config>(null, "/config")
      .then(setConfig)
      .catch((err) => setConfigError((err as Error).message));
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  if (configError) {
    return (
      <main className="center">
        <div className="card narrow">
          <h1>Wallet unavailable</h1>
          <p className="error">{configError}</p>
        </div>
      </main>
    );
  }
  if (!config) return <main className="center muted">Loading…</main>;
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
  if (checkoutId) return <DemoCheckout session={session} depositId={checkoutId} onSignOut={signOut} />;
  return <Wallet session={session} config={config} onSignOut={signOut} />;
}

// ---- sign-in -------------------------------------------------------------------

function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<{ data: DemoUser[] }>(null, "/demo-users")
      .then((r) => setUsers(r.data))
      .catch((err) => setError((err as Error).message));
  }, []);

  const pick = async (u: DemoUser) => {
    try {
      const { body } = await request<Session>(null, "POST", "/session", { body: { account_id: u.id } });
      onSignIn({ token: body.token, account: body.account });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="center">
      <div className="card narrow stack">
        <h1>Sign in</h1>
        <p className="muted">
          Demo sign-in: pick a user, no password. All money here is fictional. Each browser tab keeps its own sign-in, so
          you can be Alice in one tab and Bob in another.
        </p>
        {error && <p className="error">{error}</p>}
        {users === null && !error && <p className="muted">Loading users…</p>}
        {users?.length === 0 && (
          <p className="muted">
            No users yet. Run <code>npm run demo:seed</code> (or <code>docker compose up</code>, which seeds for you).
          </p>
        )}
        <ul className="plain users">
          {users?.map((u) => (
            <li key={u.id}>
              <button className="user" onClick={() => void pick(u)}>
                <span className="avatar" aria-hidden>
                  {u.name.slice(0, 1)}
                </span>
                <span className="grow">{u.name}</span>
                <span className="num muted">{money(u.balance_cents, u.currency)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

// ---- the wallet ------------------------------------------------------------------

interface Data {
  balances: Balances;
  activity: ActivityItem[];
  statement: StatementLine[];
  payees: { id: string; name: string }[];
}

function Wallet({ session, config, onSignOut }: { session: Session; config: Config; onSignOut: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const lastStatus = useRef<Map<string, string>>(new Map());
  const returnedDeposit = useUrlParam("deposit");
  const [showReturn, setShowReturn] = useState(Boolean(returnedDeposit));

  const refresh = useCallback(async () => {
    try {
      const [balances, activity, statement, payees] = await Promise.all([
        get<Balances>(session, ""),
        get<{ data: ActivityItem[] }>(session, "/activity?limit=200"),
        get<{ data: StatementLine[] }>(session, "/statement?limit=500"),
        get<{ data: { id: string; name: string }[] }>(session, "/payees"),
      ]);
      // Highlight rows whose status moved since the last poll (a payout settling, a webhook arriving).
      const prev = lastStatus.current;
      const moved = new Set<string>();
      for (const item of activity.data) {
        const before = prev.get(item.id);
        if (prev.size > 0 && before !== item.status) moved.add(item.id);
      }
      lastStatus.current = new Map(activity.data.map((i) => [i.id, i.status]));
      setChanged(moved);
      setData({ balances, activity: activity.data, statement: statement.data, payees: payees.data });
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignOut();
      setError((err as Error).message);
    }
  }, [session, onSignOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const returned = returnedDeposit ? data?.activity.find((i) => i.id === `deposit:${returnedDeposit}`) : undefined;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Hi, {session.account.name}</h1>
          <p className="muted small">Demo wallet. All money is fictional.</p>
        </div>
        <div className="row">
          <a className="muted small" href="/dashboard/">
            Admin dashboard
          </a>
          <button className="ghost" onClick={onSignOut}>
            Switch user
          </button>
        </div>
      </header>

      {error && <p className="banner bad">Could not refresh: {error}</p>}
      {showReturn && returnedDeposit && (
        <div className={`banner ${returned?.state ?? "pending"}`}>
          <div className="spread row">
            <span>
              {returned?.state === "settled"
                ? `Your deposit of ${money(returned.amount_cents, returned.currency)} has arrived.`
                : returned?.state === "failed"
                  ? `Your deposit did not go through (${returned.status_label.toLowerCase()}).`
                  : "Back from checkout. The deposit is credited when the payment provider's signed webhook confirms it, not when the browser comes back. It is pending until then."}
            </span>
            <button
              className="ghost small"
              onClick={() => {
                setShowReturn(false);
                clearUrl();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {data ? <BalanceTiles b={data.balances} /> : <p className="muted">Loading…</p>}

      {data && <Actions session={session} config={config} data={data} onChanged={refresh} />}

      {data && <History activity={data.activity} statement={data.statement} changed={changed} />}

      {config.bank_controls && <DemoPanel session={session} />}
    </div>
  );
}

function BalanceTiles({ b }: { b: Balances }) {
  const c = b.account.currency;
  return (
    <section className="tiles" aria-label="Balances">
      <div className="tile main">
        <div className="tile-label">Available balance</div>
        <div className="tile-value">{money(b.available_cents, c)}</div>
      </div>
      <div className="tile">
        <div className="tile-label">On its way to your bank</div>
        <div className="tile-value small-value">{money(b.on_hold_cents, c)}</div>
        <div className="tile-hint">Withdrawals the bank has not paid out yet. Already taken out of your balance.</div>
      </div>
      <div className="tile">
        <div className="tile-label">Deposits in progress</div>
        <div className="tile-value small-value">{money(b.incoming_cents, c)}</div>
        <div className="tile-hint">Not spendable until the payment is confirmed.</div>
      </div>
    </section>
  );
}

// ---- operations ---------------------------------------------------------------------

type OpState =
  | { phase: "idle" }
  | { phase: "sending"; attempts: Attempts }
  | { phase: "done"; result: WriteResult; status: number; attempts: Attempts }
  | { phase: "unknown"; message: string; attempts: Attempts }
  | { phase: "error"; message: string; attempts: Attempts };

/**
 * Runs one form's operation with one Idempotency-Key per intention (see
 * idempotent.ts). `times` > 1 fires that many identical requests at once,
 * which is what a fast double-click does.
 */
function useOperation(send: (key: string, body: unknown) => Promise<Response<WriteResult>>) {
  const draft = useRef(new Draft());
  const attempts = useRef<Attempts & { key: string }>({ key: "", sent: 0, answered: 0, replayed: 0 });
  const [state, setState] = useState<OpState>({ phase: "idle" });

  const run = useCallback(
    async (body: unknown, times = 1) => {
      const key = draft.current.keyFor(body);
      if (attempts.current.key !== key) attempts.current = { key, sent: 0, answered: 0, replayed: 0 };
      const a = attempts.current;
      a.sent += times;
      setState({ phase: "sending", attempts: { ...a } });
      const results = await Promise.allSettled(Array.from({ length: times }, () => send(key, body)));
      let done: Response<WriteResult> | undefined;
      let failure: unknown;
      for (const r of results) {
        if (r.status === "fulfilled") {
          a.answered++;
          if (r.value.replayed) a.replayed++;
          if (!done || done.replayed) done = r.value;
        } else failure = r.reason;
      }
      if (attempts.current !== a) return null; // the form changed while this was in flight
      if (done) {
        setState({ phase: "done", result: done.body, status: done.status, attempts: { ...a } });
        return done.body;
      }
      const message = (failure as Error).message;
      setState(
        isUnknownOutcome(failure) ? { phase: "unknown", message, attempts: { ...a } } : { phase: "error", message, attempts: { ...a } },
      );
      return null;
    },
    [send],
  );

  const reset = useCallback(() => {
    draft.current.reset();
    attempts.current = { key: "", sent: 0, answered: 0, replayed: 0 };
    setState({ phase: "idle" });
  }, []);

  /** Hide the last outcome (the form changed) without forgetting the key. */
  const dismiss = useCallback(() => setState((s) => (s.phase === "sending" ? s : { phase: "idle" })), []);

  return { state, run, reset, dismiss };
}

/** Signed as it would show on a bank statement: money in is +, money out is −. */
function signedAmount(item: ActivityItem): number {
  if (item.kind === "deposit" || item.kind === "transfer_in") return item.amount_cents;
  if (item.kind === "adjustment") return item.balance_effect_cents;
  return -item.amount_cents;
}

function Actions({ session, config, data, onChanged }: { session: Session; config: Config; data: Data; onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState<"send" | "add" | "withdraw">("send");
  return (
    <section className="card">
      <div className="tabs" role="tablist">
        {(
          [
            ["send", "Send money"],
            ["add", "Add funds"],
            ["withdraw", "Withdraw"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "send" && <SendForm session={session} payees={data.payees} currency={data.balances.account.currency} onChanged={onChanged} />}
      {tab === "add" && <AddFundsForm session={session} config={config} currency={data.balances.account.currency} />}
      {tab === "withdraw" && <WithdrawForm session={session} currency={data.balances.account.currency} onChanged={onChanged} />}
    </section>
  );
}

function AmountField({ value, onChange, currency }: { value: string; onChange: (v: string) => void; currency: string }) {
  return (
    <label className="field">
      Amount ({currency})
      <input inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => onChange(e.target.value)} required />
    </label>
  );
}

function Outcome({ state, onNew, success }: { state: OpState; onNew: () => void; success: (r: WriteResult) => ReactNode }) {
  if (state.phase === "idle") return null;
  const note = describeAttempts(state.attempts);
  const body = (() => {
    switch (state.phase) {
      case "sending":
        return <p className="muted">Sending…</p>;
      case "done":
        return state.result.error ? (
          <p className="error">{state.result.error.message} Nothing moved. It is in your activity as failed.</p>
        ) : (
          <p className="ok">{success(state.result)}</p>
        );
      case "unknown":
        return (
          <p className="error">
            {state.message} It may or may not have gone through. Pressing the button again is safe: it reuses the same
            Idempotency-Key, so it cannot happen twice.
          </p>
        );
      case "error":
        return <p className="error">{state.message}</p>;
    }
  })();
  return (
    <div className="outcome">
      {body}
      {note && <p className="small muted">{note}</p>}
      {state.phase === "done" && (
        <button type="button" className="link" onClick={onNew}>
          Start a new one
        </button>
      )}
    </div>
  );
}

function SendForm({
  session,
  payees,
  currency,
  onChanged,
}: {
  session: Session;
  payees: { id: string; name: string }[];
  currency: string;
  onChanged: () => Promise<void>;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const send = useCallback(
    (key: string, body: unknown) => request<WriteResult>(session, "POST", "/transfers", { body, idempotencyKey: key }),
    [session],
  );
  const op = useOperation(send);
  const { dismiss } = op;
  useEffect(dismiss, [to, amount, dismiss]);
  const cents = parseAmount(amount);
  const recipient = to || payees[0]?.id || "";
  const body = { to_account_id: recipient, amount_cents: cents };

  const submit = async (times: number) => {
    if (!cents || !recipient) return;
    await op.run(body, times);
    await onChanged();
  };

  return (
    <form
      className="form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit(1);
      }}
    >
      <label className="field">
        To
        <select value={recipient} onChange={(e) => setTo(e.target.value)}>
          {payees.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <AmountField value={amount} onChange={setAmount} currency={currency} />
      {amount && !cents && <p className="error small">Enter an amount like 12.50.</p>}
      <div className="row">
        <button type="submit" disabled={!cents || !recipient}>
          Send
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!cents || !recipient}
          onClick={() => void submit(2)}
          title="Fires two identical requests at once, like a fast double-click"
        >
          Double-click test: send twice at once
        </button>
      </div>
      <Outcome
        state={op.state}
        onNew={() => {
          op.reset();
          setAmount("");
        }}
        success={(r) => `${r.item.title}: ${money(r.item.amount_cents, r.item.currency)}.`}
      />
    </form>
  );
}

function AddFundsForm({ session, config, currency }: { session: Session; config: Config; currency: string }) {
  const [amount, setAmount] = useState("");
  const send = useCallback(
    (key: string, body: unknown) => request<WriteResult>(session, "POST", "/deposits", { body, idempotencyKey: key }),
    [session],
  );
  const op = useOperation(send);
  const cents = parseAmount(amount);

  if (config.deposits === "disabled") {
    return (
      <p className="muted">
        Deposits are switched off on this server. Set <code>STRIPE_SECRET_KEY</code> (a test-mode key), or run with{" "}
        <code>DEMO_MODE=true</code> for the demo checkout.
      </p>
    );
  }
  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!cents) return;
        const result = await op.run({ amount_cents: cents });
        if (result?.checkout_url) window.location.assign(result.checkout_url);
      }}
    >
      <p className="muted small">
        {config.deposits === "stripe_test"
          ? "You will pay on Stripe Checkout in test mode. Use the card 4242 4242 4242 4242, any future date, any CVC."
          : "You will pay on the demo checkout page, which stands in for Stripe. It sends the signed webhook Stripe would send."}{" "}
        The money is credited when the webhook arrives, not when you come back.
      </p>
      <AmountField value={amount} onChange={setAmount} currency={currency} />
      {amount && !cents && <p className="error small">Enter an amount like 25.00.</p>}
      <div className="row">
        <button type="submit" disabled={!cents || op.state.phase === "sending"}>
          Continue to checkout
        </button>
      </div>
      <Outcome state={op.state} onNew={op.reset} success={() => "Opening checkout…"} />
    </form>
  );
}

const BANK_ACCOUNTS = [
  { number: "000123451111", label: "Checking ••1111", hint: "Pays out normally after a few seconds." },
  { number: "000123450002", label: "Closed account ••0002", hint: "The bank accepts it, then fails it. The hold is released." },
  { number: "000123450004", label: "Invalid account ••0004", hint: "The bank refuses it straight away. The hold is released." },
  { number: "000123450005", label: "Frozen account ••0005", hint: "Paid out, then returned by the receiving bank." },
];

function WithdrawForm({ session, currency, onChanged }: { session: Session; currency: string; onChanged: () => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState(BANK_ACCOUNTS[0].number);
  const send = useCallback(
    (key: string, body: unknown) => request<WriteResult>(session, "POST", "/payouts", { body, idempotencyKey: key }),
    [session],
  );
  const op = useOperation(send);
  const { dismiss } = op;
  useEffect(dismiss, [account, amount, dismiss]);
  const cents = parseAmount(amount);
  const chosen = BANK_ACCOUNTS.find((a) => a.number === account)!;

  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!cents) return;
        await op.run({ amount_cents: cents, bank_account_number: account });
        await onChanged();
      }}
    >
      <label className="field">
        To bank account
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {BANK_ACCOUNTS.map((a) => (
            <option key={a.number} value={a.number}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{chosen.hint} The mock bank picks the outcome from the last four digits.</p>
      <AmountField value={amount} onChange={setAmount} currency={currency} />
      {amount && !cents && <p className="error small">Enter an amount like 20.00.</p>}
      <div className="row">
        <button type="submit" disabled={!cents}>
          Withdraw
        </button>
      </div>
      <Outcome
        state={op.state}
        onNew={() => {
          op.reset();
          setAmount("");
        }}
        success={(r) => `${money(r.item.amount_cents, r.item.currency)} is on hold and on its way to the bank. Watch it settle below.`}
      />
    </form>
  );
}

// ---- history -------------------------------------------------------------------------

const STATE_LABEL: Record<ActivityState, string> = { pending: "Pending", settled: "Settled", failed: "Failed" };
const KIND_ICON: Record<ActivityItem["kind"], string> = {
  deposit: "↓",
  payout: "↑",
  transfer_in: "←",
  transfer_out: "→",
  adjustment: "±",
};

function History({ activity, statement, changed }: { activity: ActivityItem[]; statement: StatementLine[]; changed: Set<string> }) {
  const [view, setView] = useState<"activity" | "statement">("activity");
  const [filter, setFilter] = useState<ActivityState | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const counts = useMemo(() => {
    const c = { all: activity.length, pending: 0, settled: 0, failed: 0 };
    for (const i of activity) c[i.state]++;
    return c;
  }, [activity]);
  const shown = filter === "all" ? activity : activity.filter((i) => i.state === filter);

  return (
    <section className="card">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === "activity"} className={view === "activity" ? "tab active" : "tab"} onClick={() => setView("activity")}>
            Activity
          </button>
          <button role="tab" aria-selected={view === "statement"} className={view === "statement" ? "tab active" : "tab"} onClick={() => setView("statement")}>
            Ledger statement
          </button>
        </div>
        {view === "activity" && (
          <div className="chips">
            {(["all", "pending", "settled", "failed"] as const).map((f) => (
              <button key={f} className={filter === f ? "chip active" : "chip"} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : STATE_LABEL[f]} <span className="count">{counts[f]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {view === "activity" ? (
        shown.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <ul className="plain activity">
            {shown.map((item) => (
              <li key={item.id} className={changed.has(item.id) ? "changed" : undefined}>
                <button className="activity-row" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>
                  <span className={`icon ${item.state}`} aria-hidden>
                    {KIND_ICON[item.kind]}
                  </span>
                  <span className="grow">
                    <span className="title">{item.title}</span>
                    <span className="muted small">
                      {when(item.created_at)} · {item.status_label}
                    </span>
                  </span>
                  <span className="right">
                    <span className={`amount ${item.state}`}>
                      {money(signedAmount(item), item.currency, { sign: true })}
                    </span>
                    <span className={`badge ${item.state}`}>{STATE_LABEL[item.state]}</span>
                  </span>
                </button>
                {open === item.id && <ItemDetail item={item} postings={statement.filter((l) => l.activity_id === item.id)} />}
              </li>
            ))}
          </ul>
        )
      ) : (
        <Statement lines={statement} />
      )}
    </section>
  );
}

function ItemDetail({ item, postings }: { item: ActivityItem; postings: StatementLine[] }) {
  return (
    <div className="detail">
      <dl>
        <dt>Status</dt>
        <dd>
          {item.status_label} <span className="mono small muted">({item.status})</span>
        </dd>
        <dt>Effect on balance now</dt>
        <dd className="num-left">{money(item.balance_effect_cents, item.currency, { sign: true })}</dd>
        {item.failure_reason && (
          <>
            <dt>Reason</dt>
            <dd className="mono small">{item.failure_reason}</dd>
          </>
        )}
        <dt>Last updated</dt>
        <dd>{when(item.updated_at)}</dd>
        <dt>Id</dt>
        <dd className="mono small">{item.object_id}</dd>
      </dl>
      <h3>Ledger postings</h3>
      {postings.length === 0 ? (
        <p className="muted small">None: no money has moved for this {item.state === "failed" ? "(and none will)" : "yet"}.</p>
      ) : (
        <ul className="plain postings">
          {[...postings].reverse().map((l) => (
            <li key={l.entry_id} className="row spread">
              <span>{l.description}</span>
              <span className="num">{money(l.amount_cents, l.currency, { sign: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Statement({ lines }: { lines: StatementLine[] }) {
  if (lines.length === 0) return <p className="muted">No ledger postings yet.</p>;
  return (
    <>
      <p className="muted small">
        Every posting to your account in the double-entry ledger, newest first. The ledger is append-only: a failed
        withdrawal is a hold and a release, never an edit.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Description</th>
              <th className="num">Amount</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.entry_id}>
                <td className="nowrap">{when(l.created_at)}</td>
                <td>{l.description}</td>
                <td className={`num ${l.amount_cents < 0 ? "neg" : ""}`}>{money(l.amount_cents, l.currency, { sign: true })}</td>
                <td className="num">{money(l.balance_after_cents, l.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- demo controls --------------------------------------------------------------------

function DemoPanel({ session }: { session: Session }) {
  const [behaviour, setBehaviour] = useState<BankBehaviour | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBehaviour((await get<{ behaviour: BankBehaviour }>(session, "/demo/bank")).behaviour);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const set = async (change: Partial<BankBehaviour>) => {
    try {
      const { body } = await request<{ behaviour: BankBehaviour }>(session, "POST", "/demo/bank", { body: change });
      setBehaviour(body.behaviour);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card demo">
      <h2>Make the bank misbehave</h2>
      <p className="muted small">
        Switches on the mock bank, for demos. Make a withdrawal after flipping one and watch its status: the platform
        retries with the same idempotency key, deduplicates webhooks, and asks the bank when it hears nothing.
      </p>
      {error && <p className="error">{error}</p>}
      {behaviour && (
        <ul className="plain switches">
          <Switch
            on={behaviour.outage}
            label="Bank outage"
            hint="Every call fails. Withdrawals stay pending, retried with backoff, until you switch it off."
            onToggle={() => void set({ outage: !behaviour.outage })}
          />
          <Switch
            on={behaviour.loseResponses > 0}
            label={behaviour.loseResponses > 0 ? `Lose the next ${behaviour.loseResponses} response(s)` : "Lose the next response"}
            hint="The bank makes the payout but its answer never arrives. The retry gets the same payout back, not a second one."
            onToggle={() => void set({ loseResponses: behaviour.loseResponses > 0 ? 0 : 1 })}
          />
          <Switch
            on={behaviour.webhookCopies > 1}
            label="Send every webhook twice"
            hint="The second copy is recognised as a duplicate and changes nothing."
            onToggle={() => void set({ webhookCopies: behaviour.webhookCopies > 1 ? 1 : 2 })}
          />
          <Switch
            on={!behaviour.webhooksEnabled}
            label="Stop sending webhooks"
            hint="Nobody tells us the outcome. The worker asks the bank about quiet payouts, and the admin dashboard's reconciliation finds it."
            onToggle={() => void set({ webhooksEnabled: !behaviour.webhooksEnabled })}
          />
        </ul>
      )}
    </section>
  );
}

function Switch({ on, label, hint, onToggle }: { on: boolean; label: string; hint: string; onToggle: () => void }) {
  return (
    <li className="switch-row">
      <button role="switch" aria-checked={on} className={on ? "switch on" : "switch"} onClick={onToggle}>
        <span className="knob" />
      </button>
      <span>
        <span className="title">{label}</span>
        <span className="muted small block">{hint}</span>
      </span>
    </li>
  );
}

// ---- demo checkout --------------------------------------------------------------------

const CHECKOUT_OUTCOMES = [
  { outcome: "pay", label: "Pay", hint: "Stripe sends checkout.session.completed, paid." },
  { outcome: "pay_duplicate_webhook", label: "Pay, and deliver the webhook twice", hint: "The second delivery is a duplicate and credits nothing." },
  { outcome: "bank_debit_fails", label: "Pay by bank debit, which then fails", hint: "Processing first, then async_payment_failed." },
  { outcome: "abandon", label: "Abandon checkout", hint: "The session expires. Nothing is collected." },
] as const;

function DemoCheckout({ session, depositId, onSignOut }: { session: Session; depositId: string; onSignOut: () => void }) {
  const [item, setItem] = useState<ActivityItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = `/wallet/?deposit=${encodeURIComponent(depositId)}&checkout=success`;

  useEffect(() => {
    get<ActivityItem>(session, `/deposits/${encodeURIComponent(depositId)}`)
      .then(setItem)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) onSignOut();
        setError((err as Error).message);
      });
  }, [session, depositId, onSignOut]);

  const choose = async (outcome: string) => {
    setBusy(true);
    try {
      await request(session, "POST", `/deposits/${encodeURIComponent(depositId)}/demo-checkout`, { body: { outcome } });
      window.location.assign(back);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <div className="card narrow stack checkout">
        <p className="eyebrow">Demo checkout · stands in for Stripe test mode</p>
        {error && <p className="error">{error}</p>}
        {item && (
          <>
            <h1>Pay {money(item.amount_cents, item.currency)}</h1>
            <p className="muted small">
              To {session.account.name}'s wallet. Choosing an outcome sends the event Stripe would send, signed with the
              webhook secret, to <code>POST /webhooks/stripe</code>, where it is verified like a real one.
            </p>
            {item.state !== "pending" ? (
              <p>
                This deposit is already {item.status_label.toLowerCase()}. <a href={back}>Back to the wallet</a>
              </p>
            ) : (
              <ul className="plain stack">
                {CHECKOUT_OUTCOMES.map((o, n) => (
                  <li key={o.outcome}>
                    <button className={n === 0 ? "wide" : "wide ghost"} disabled={busy} onClick={() => void choose(o.outcome)}>
                      <span className="title">{o.label}</span>
                      <span className="small block muted-on-button">{o.hint}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <a href={back} className="small">
                    Go back without paying (the deposit stays pending)
                  </a>
                </li>
              </ul>
            )}
          </>
        )}
      </div>
    </main>
  );
}

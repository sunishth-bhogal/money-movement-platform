import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  call,
  loadSession,
  money,
  saveSession,
  when,
  type BoxOfficeEvent,
  type EventDetail,
  type OrderTrace,
  type OrganizerEvent,
  type Overview,
  type PayoutStatement,
  type PublicOrder,
  type Session,
  type StatementSection,
} from "./api";

const param = (name: string) => new URLSearchParams(window.location.search).get(name);
const newKey = () => crypto.randomUUID();

function useAction(after?: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await after?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function App() {
  const checkoutOrder = param("demo_checkout_order");
  const order = param("order");
  const [tab, setTab] = useState<"box" | "organizer">(window.location.hash === "#organizer" ? "organizer" : "box");
  const go = (t: "box" | "organizer") => {
    setTab(t);
    window.history.replaceState(null, "", `/portal/${t === "organizer" ? "#organizer" : ""}`);
  };
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <h1>Ticket portal</h1>
          <span className="muted small">test mode · fictional money</span>
        </div>
        <div className="tabs">
          <button className={`tab ${tab === "box" && !checkoutOrder && !order ? "active" : ""}`} onClick={() => go("box")}>
            Box office
          </button>
          <button className={`tab ${tab === "organizer" && !checkoutOrder && !order ? "active" : ""}`} onClick={() => go("organizer")}>
            Organizer
          </button>
        </div>
      </header>
      {checkoutOrder ? <DemoCheckout orderId={checkoutOrder} /> : order ? <OrderStatus orderId={order} /> : tab === "box" ? <BoxOffice /> : <Organizer />}
    </div>
  );
}

// ---- box office -----------------------------------------------------------------

function BoxOffice() {
  const [events, setEvents] = useState<BoxOfficeEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call<{ data: BoxOfficeEvent[] }>("GET", "/box-office/events").then((r) => setEvents(r.data), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  if (error) return <p className="error">{error}</p>;
  if (!events) return <p className="muted">Loading events…</p>;
  if (events.length === 0) return <p className="muted">Nothing on sale. Seed the demo: docker compose run --rm seed</p>;
  return (
    <section className="events">
      {events.map((e) => (
        <article className="card event-card" key={e.id}>
          <h2>{e.name}</h2>
          <p className="muted small">
            {when(e.starts_at)} · {e.venue} · by {e.organizers.join(" & ")}
          </p>
          {e.ticket_types.map((t) => (
            <BuyForm key={t.id} event={e} type={t} />
          ))}
        </article>
      ))}
    </section>
  );
}

function BuyForm({ event, type }: { event: BoxOfficeEvent; type: BoxOfficeEvent["ticket_types"][number] }) {
  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState("Sam Rivera");
  // One key per intention to buy: a double-click or a retry after a timeout is the same order.
  const [key, setKey] = useState(newKey);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await call<{ checkout_url: string }>("POST", `/box-office/events/${event.id}/orders`, {
        idempotencyKey: key,
        body: { buyer_name: name, buyer_email: "buyer@example.test", items: [{ ticket_type_id: type.id, quantity }] },
      });
      setKey(newKey());
      window.location.assign(r.checkout_url);
    });
  };
  return (
    <form className="stack" onSubmit={submit} style={{ marginTop: 10 }}>
      <div className="row spread">
        <strong>{type.name}</strong>
        <span>
          {money(type.price_cents, event.currency)} <span className="muted small">· {type.left} left</span>
        </span>
      </div>
      <div className="inline-form">
        <input className="qty" type="number" min={1} max={20} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} aria-label="Quantity" />
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
        <button type="submit" disabled={busy || type.left < quantity}>
          {busy ? "Opening checkout…" : `Buy · ${money(type.price_cents * quantity, event.currency)}`}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

const CHECKOUT_OUTCOMES = [
  ["pay", "Pay by card", "Stripe sends checkout.session.completed (paid)"],
  ["pay_duplicate_webhook", "Pay, and Stripe delivers the webhook twice", "The same event twice: one sale"],
  ["bank_debit_fails", "Pay by bank debit, which fails", "Completed, then async_payment_failed: seats released"],
  ["abandon", "Abandon checkout", "The session expires: seats released"],
] as const;

function DemoCheckout({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => void call<PublicOrder>("GET", `/box-office/orders/${orderId}`).then(setOrder), [orderId]);
  if (!order) return <p className="muted">Loading…</p>;
  return (
    <section className="card narrow checkout stack" style={{ margin: "0 auto" }}>
      <p className="eyebrow">Demo checkout · stands in for Stripe's page</p>
      <h1>{money(order.amount_cents, order.currency)}</h1>
      <p>
        {order.tickets.length} × {order.tickets[0]?.type} for <strong>{order.event.name}</strong>
      </p>
      <p className="muted small">Each button builds the webhook Stripe would send, signs it, and posts it to /webhooks/stripe, where it is verified and applied like a real one.</p>
      {CHECKOUT_OUTCOMES.map(([outcome, label, hint]) => (
        <button
          key={outcome}
          className="wide ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call("POST", `/box-office/orders/${orderId}/demo-checkout`, { body: { outcome } });
              window.location.assign(`/portal/?order=${orderId}`);
            })
          }
        >
          <strong>{label}</strong>
          <span className="muted small">{hint}</span>
        </button>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function OrderStatus({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<PublicOrder | null>(null);
  useEffect(() => {
    const load = () => call<PublicOrder>("GET", `/box-office/orders/${orderId}`).then(setOrder, () => {});
    void load();
    // Only the webhook moves an order: show "pending" until it arrives.
    const t = setInterval(load, 2_000);
    return () => clearInterval(t);
  }, [orderId]);
  if (!order) return <p className="muted">Loading…</p>;
  const paid = order.status === "paid";
  return (
    <section className="card narrow stack" style={{ margin: "0 auto" }}>
      <p className="eyebrow">Your order</p>
      <h2>{order.event.name}</h2>
      <div className={`banner ${paid ? "settled" : order.status === "pending" || order.status === "processing" ? "pending" : "bad"}`}>
        {paid ? "Paid. Your tickets are below." : order.status === "pending" ? "Waiting for the payment to be confirmed…" : `This order is ${order.status}.`}
        {order.event.status === "cancelled" && <p>The event was cancelled ({order.event.cancel_reason}). You are refunded in full.</p>}
      </div>
      <ul className="plain">
        {order.tickets.map((t) => (
          <li key={t.id} className="row spread">
            <span>
              {t.type} <span className="muted small mono">{t.id.slice(0, 8)}</span>
            </span>
            <span>
              {money(t.price_cents, order.currency)} <span className={`badge ${t.status === "valid" ? "settled" : "failed"}`}>{t.status}</span>
              {t.refunded_cents > 0 && t.status !== "refunded" && <span className="muted small"> {money(t.refunded_cents)} refunded</span>}
            </span>
          </li>
        ))}
      </ul>
      {order.refunds.map((r, i) => (
        <p key={i} className="small">
          Refund {money(r.amount_cents, order.currency)} ({r.reason.replaceAll("_", " ")}): <span className={`badge ${r.status === "succeeded" ? "settled" : "pending"}`}>{r.status}</span>
        </p>
      ))}
      <a href="/portal/">Back to the box office</a>
    </section>
  );
}

// ---- organizer --------------------------------------------------------------------

function Organizer() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [organizers, setOrganizers] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!session) void call<{ data: { id: string; name: string }[] }>("GET", "/organizer/demo-organizers").then((r) => setOrganizers(r.data), (e) => setError(e.message));
  }, [session]);
  if (session) {
    return (
      <Dashboard
        session={session}
        signOut={() => {
          saveSession(null);
          setSession(null);
        }}
      />
    );
  }
  return (
    <section className="card narrow stack" style={{ margin: "0 auto" }}>
      <h2>Sign in as an organizer</h2>
      <p className="muted small">A demo sign-in: pick an organizer. Everything after it is scoped to them.</p>
      {error && <p className="error">{error}</p>}
      <div className="users">
        {(organizers ?? []).map((o) => (
          <button
            key={o.id}
            className="user"
            onClick={() =>
              void call<Session>("POST", "/organizer/session", { body: { organizer_id: o.id } }).then((s) => {
                saveSession(s);
                setSession(s);
              })
            }
          >
            <span className="avatar">{o.name[0]}</span>
            {o.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function Dashboard({ session, signOut }: { session: Session; signOut: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<OrganizerEvent[]>([]);
  const [config, setConfig] = useState<{ demo: boolean; bank_controls: boolean }>({ demo: false, bank_controls: false });
  const [view, setView] = useState<"payouts" | "events">("payouts");
  const [eventId, setEventId] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [o, e] = await Promise.all([
        call<Overview>("GET", "/organizer/", { session }),
        call<{ data: OrganizerEvent[] }>("GET", "/organizer/events", { session }),
      ]);
      setOverview(o);
      setEvents(e.data);
      setError(null);
    } catch (err) {
      if ((err as { status?: number }).status === 401) signOut();
      setError((err as Error).message);
    }
  }, [session, signOut]);
  useEffect(() => {
    void refresh();
    void call<{ demo: boolean; bank_controls: boolean }>("GET", "/organizer/config").then(setConfig);
    const t = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!overview) return <p className="muted">{error ?? "Loading…"}</p>;
  const b = overview.balances;
  const cur = overview.organizer.currency;
  return (
    <>
      <div className="topbar">
        <div>
          <p className="eyebrow">Organizer</p>
          <h2>{overview.organizer.name}</h2>
          <p className="muted small">Payouts go to the bank account ending {overview.organizer.bank_account_last4}</p>
        </div>
        <button className="ghost small" onClick={signOut}>
          Sign out
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="tiles">
        <div className={`tile ${b.available_cents < 0 ? "owed" : "main"}`}>
          <div className="tile-label">{b.available_cents < 0 ? "You owe" : "Ready for your next payout"}</div>
          <div className="tile-value">{money(Math.abs(b.available_cents), cur)}</div>
          <div className="tile-hint">{b.available_cents < 0 ? "Taken from your next payout before anything is paid" : "Paid out when your next event's money is released"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Held until your events happen</div>
          <div className="tile-value small-value">{money(b.held_cents, cur)}</div>
          <div className="tile-hint">Refunds come out of this first</div>
        </div>
        <div className="tile">
          <div className="tile-label">On its way to your bank</div>
          <div className="tile-value small-value">{money(b.in_flight_cents, cur)}</div>
          <div className="tile-hint">Sent; the bank has not confirmed it yet</div>
        </div>
      </div>
      {config.demo && <DemoPanel session={session} bankControls={config.bank_controls} onDone={refresh} />}
      <div className="tabs">
        <button className={`tab ${view === "payouts" ? "active" : ""}`} onClick={() => setView("payouts")}>
          Payouts
        </button>
        <button className={`tab ${view === "events" ? "active" : ""}`} onClick={() => setView("events")}>
          Events ({events.length})
        </button>
      </div>
      {traceId && <Trace session={session} orderId={traceId} close={() => setTraceId(null)} />}
      {view === "payouts" ? (
        <Payouts overview={overview} onTrace={setTraceId} />
      ) : eventId ? (
        <EventView session={session} eventId={eventId} demo={config.demo} back={() => setEventId(null)} onTrace={setTraceId} onChange={refresh} />
      ) : (
        <Events session={session} events={events} demo={config.demo} open={setEventId} onChange={refresh} />
      )}
    </>
  );
}

const PAYOUT_BADGE: Record<string, [string, string]> = {
  pending: ["pending", "Sending to your bank"],
  submitted: ["pending", "Your bank is processing it"],
  succeeded: ["settled", "Paid"],
  failed: ["failed", "The bank did not pay it: back in your balance"],
  returned: ["failed", "Sent back by your bank: back in your balance"],
};

function Payouts({ overview, onTrace }: { overview: Overview; onTrace: (orderId: string) => void }) {
  const cur = overview.organizer.currency;
  return (
    <section className="stack">
      <Statement title="Next payout, so far" statement={overview.upcoming} currency={cur} onTrace={onTrace} />
      {overview.held.length > 0 && (
        <div className="card stack">
          <h2>Held until after your events</h2>
          <p className="muted small">Ticket money is kept until the event has happened (and its hold period has passed), so refunds can be paid from it.</p>
          {overview.held.map((h) => (
            <Section key={h.event!.id} section={{ ...h.section, title: `${h.section.title} · released ${when(h.event!.release_due_at)}` }} currency={cur} onTrace={onTrace} />
          ))}
        </div>
      )}
      {overview.payouts.length === 0 && <p className="muted">No payouts yet. Your first one is sent after your first event.</p>}
      {overview.payouts.map((s) => (
        <Statement key={s.payout!.id} statement={s} currency={cur} onTrace={onTrace} />
      ))}
    </section>
  );
}

/** The killer screen: why a payout is the amount it is, line by line, down to the tickets. */
function Statement({ statement, currency, onTrace, title }: { statement: PayoutStatement; currency: string; onTrace: (o: string) => void; title?: string }) {
  const p = statement.payout;
  const [cls, label] = p ? (PAYOUT_BADGE[p.status] ?? ["pending", p.status]) : ["", ""];
  return (
    <article className="card statement">
      <div className="statement-head">
        <div>
          <p className="eyebrow">{title ?? `Payout · ${when(p!.created_at)}`}</p>
          <div className={`statement-amount ${statement.total_cents < 0 ? "neg" : ""}`}>
            {statement.total_cents < 0 ? `You owe ${money(-statement.total_cents, currency)}` : money(statement.total_cents, currency)}
          </div>
          {p && <span className={`badge ${cls}`}>{label}</span>}
        </div>
        <span className={`check ${statement.balanced ? "ok" : "error"}`} title="Every line is a ledger entry; they add up to the payout">
          {statement.balanced ? "✓ adds up to the cent" : "✗ does not add up"}
        </span>
      </div>
      <ul className="summary">
        {statement.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {statement.sections.map((s, i) => (
        <Section key={i} section={s} currency={currency} onTrace={onTrace} />
      ))}
      {statement.opening_balance_cents !== 0 && (
        <p className="small">
          Balance before this: <strong>{money(statement.opening_balance_cents, currency)}</strong>
        </p>
      )}
    </article>
  );
}

function Section({ section, currency, onTrace }: { section: StatementSection; currency: string; onTrace: (o: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const share = section.event && section.event.share_bps < 10_000 ? ` · your ${section.event.share_bps / 100}% share` : "";
  return (
    <div className="section">
      <div className="section-title">
        <span>
          {section.title}
          <span className="muted small">{share}</span>
        </span>
      </div>
      <table className="lines">
        <tbody>
          {section.lines.map((l) => (
            <LineRow key={l.kind} line={l} currency={currency} open={open === l.kind} toggle={() => setOpen(open === l.kind ? null : l.kind)} onTrace={onTrace} />
          ))}
          <tr className="total">
            <td>{section.event ? "Comes to" : "Total"}</td>
            <td className={`num ${section.total_cents < 0 ? "neg" : ""}`}>{money(section.total_cents, currency)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function LineRow({ line, currency, open, toggle, onTrace }: { line: StatementSection["lines"][number]; currency: string; open: boolean; toggle: () => void; onTrace: (o: string) => void }) {
  const counted = line.kind === "ticket_sale" ? `${line.count} ticket${line.count === 1 ? "" : "s"}` : line.count > 1 ? `${line.count}` : "";
  return (
    <>
      <tr>
        <td>
          <button className={`line-toggle ${open ? "open" : ""}`} onClick={toggle}>
            {line.label}
          </button>{" "}
          {counted && <span className="muted small">({counted})</span>}
        </td>
        <td className={`num ${line.amount_cents < 0 ? "neg" : ""}`}>{money(line.amount_cents, currency)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={2}>
            <ul className="items">
              {line.items.map((i) => (
                <li key={`${i.transfer_id}-${i.bucket}`}>
                  <span>
                    {i.memo}
                    {i.order_id && (
                      <>
                        {" · "}
                        <button className="link small" onClick={() => onTrace(i.order_id!)}>
                          order {i.order_id.slice(0, 8)}
                        </button>
                      </>
                    )}
                    <span> · {when(i.created_at)}</span>
                  </span>
                  <span className="num">{money(i.amount_cents, currency)}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function Events({ session, events, demo, open, onChange }: { session: Session; events: OrganizerEvent[]; demo: boolean; open: (id: string) => void; onChange: () => Promise<void> }) {
  return (
    <section className="stack">
      {events.map((e) => (
        <EventCard key={e.id} session={session} e={e} demo={demo} open={() => open(e.id)} onChange={onChange} />
      ))}
    </section>
  );
}

function eventStatus(e: OrganizerEvent): [string, string] {
  if (e.status === "cancelled") return ["failed", `Cancelled: ${e.cancel_reason}`];
  if (e.released_at) return ["settled", "Paid out"];
  if (new Date(e.ends_at) <= new Date()) return ["pending", `Ended · money released ${when(e.release_due_at)}`];
  return ["pending", `On sale · ${when(e.starts_at)}`];
}

function EventCard({ session, e, demo, open, onChange }: { session: Session; e: OrganizerEvent; demo: boolean; open: () => void; onChange: () => Promise<void> }) {
  const [cls, label] = eventStatus(e);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction(onChange);
  const upcoming = e.status === "on_sale" && !e.released_at && new Date(e.starts_at) > new Date();
  return (
    <article className="card stack">
      <div className="row spread">
        <div>
          <button className="link" onClick={open}>
            <strong>{e.name}</strong>
          </button>
          <p className="muted small">
            {e.venue} {e.co_hosts.length > 0 && `· co-hosted with ${e.co_hosts.join(", ")} (your share ${e.share_bps / 100}%)`}
          </p>
        </div>
        <span className={`badge ${cls}`}>{label}</span>
      </div>
      <p className="small">
        {e.tickets_sold} tickets · {money(e.gross_cents)} sold{e.refunded_cents > 0 && ` · ${money(e.refunded_cents)} refunded`}
      </p>
      <div className="row">
        {upcoming && e.advance_bps > 0 && (
          <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", `/organizer/events/${e.id}/advance`, { session }))}>
            Take an early payout ({e.advance_bps / 100}% of held)
          </button>
        )}
        {e.status === "on_sale" && !e.released_at && !cancelling && (
          <button className="small ghost" onClick={() => setCancelling(true)}>
            Cancel event…
          </button>
        )}
        {demo && e.status === "on_sale" && !e.released_at && (
          <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", `/organizer/demo/events/${e.id}/finish`, { session }))}>
            Demo: the event happens now
          </button>
        )}
      </div>
      {cancelling && (
        <form
          className="inline-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(() => call("POST", `/organizer/events/${e.id}/cancel`, { session, body: { reason } })).then(() => setCancelling(false));
          }}
        >
          <input placeholder="Why? Customers see this" value={reason} onChange={(ev) => setReason(ev.target.value)} minLength={3} required />
          <button type="submit" className="small" disabled={busy}>
            Cancel and refund everyone
          </button>
          <button type="button" className="small ghost" onClick={() => setCancelling(false)}>
            Keep it
          </button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

function EventView({ session, eventId, demo, back, onTrace, onChange }: { session: Session; eventId: string; demo: boolean; back: () => void; onTrace: (o: string) => void; onChange: () => Promise<void> }) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const load = useCallback(() => call<EventDetail>("GET", `/organizer/events/${eventId}`, { session }).then(setDetail), [eventId, session]);
  useEffect(() => void load(), [load]);
  const after = async () => {
    await load();
    await onChange();
  };
  if (!detail) return <p className="muted">Loading…</p>;
  const e = detail.event;
  return (
    <section className="card stack">
      <button className="link small" onClick={back}>
        ← All events
      </button>
      <h2>{e.name}</h2>
      <p className="muted small">
        {when(e.starts_at)} · {e.venue} · split {detail.organizers.map((o) => `${o.name} ${o.share_bps / 100}%`).join(", ")}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Tickets</th>
              <th className="num">Paid</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {detail.orders.map((o) => (
              <OrderRow key={o.id} session={session} o={o} demo={demo} onTrace={onTrace} onDone={after} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderRow({ session, o, demo, onTrace, onDone }: { session: Session; o: EventDetail["orders"][number]; demo: boolean; onTrace: (id: string) => void; onDone: () => Promise<void> }) {
  const [refunding, setRefunding] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(newKey);
  const { busy, error, run } = useAction(onDone);
  const refund = (ticketId: string, cents?: number) =>
    run(async () => {
      await call("POST", `/organizer/orders/${o.id}/refunds`, {
        session,
        idempotencyKey: key,
        body: { ticket_id: ticketId, ...(cents ? { amount_cents: cents } : {}), reason: "requested_by_customer" },
      });
      setKey(newKey());
      setRefunding(null);
    });
  return (
    <tr>
      <td>
        <button className="link" onClick={() => onTrace(o.id)}>
          {o.buyer_name}
        </button>
        <div className="muted small">{when(o.created_at)}</div>
      </td>
      <td>
        {(o.tickets ?? []).map((t) => (
          <div key={t.id} className="small">
            {t.type} {money(t.price_cents, o.currency)}{" "}
            <span className={`badge ${t.status === "valid" ? "settled" : t.status === "reserved" ? "pending" : "failed"}`}>{t.status}</span>
            {t.refunded_cents > 0 && t.status !== "refunded" && <span className="muted"> {money(t.refunded_cents)} refunded</span>}
            {o.status === "paid" && t.status === "valid" && (
              <>
                {" "}
                <button className="link small" onClick={() => setRefunding(refunding === t.id ? null : t.id)}>
                  refund
                </button>
              </>
            )}
            {refunding === t.id && (
              <form
                className="inline-form"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void refund(t.id, amount ? Math.round(Number(amount) * 100) : undefined);
                }}
              >
                <input placeholder={`Amount (blank: all ${money(t.price_cents - t.refunded_cents)})`} value={amount} onChange={(ev) => setAmount(ev.target.value)} inputMode="decimal" />
                <button type="submit" className="small" disabled={busy}>
                  Refund
                </button>
              </form>
            )}
          </div>
        ))}
      </td>
      <td className="num">
        {money(o.amount_cents, o.currency)}
        {o.disputed_cents > 0 && <div className="small neg">charged back {money(o.disputed_cents)}</div>}
      </td>
      <td>
        <span className={`badge ${o.status === "paid" ? "settled" : o.status === "pending" || o.status === "processing" ? "pending" : "failed"}`}>{o.status}</span>
      </td>
      <td>
        {demo && o.status === "paid" && (
          <div className="row">
            {o.disputed_cents === 0 ? (
              <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", `/organizer/demo/orders/${o.id}/dispute`, { session, body: { outcome: "open" } }))}>
                Demo: chargeback
              </button>
            ) : (
              <>
                <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", `/organizer/demo/orders/${o.id}/dispute`, { session, body: { outcome: "won" } }))}>
                  won
                </button>
                <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", `/organizer/demo/orders/${o.id}/dispute`, { session, body: { outcome: "lost" } }))}>
                  lost
                </button>
              </>
            )}
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </td>
    </tr>
  );
}

/** The audit trail of one order: payment, tickets, refunds, chargebacks, and every ledger transfer behind them. */
function Trace({ session, orderId, close }: { session: Session; orderId: string; close: () => void }) {
  const [trace, setTrace] = useState<OrderTrace | null>(null);
  useEffect(() => void call<OrderTrace>("GET", `/organizer/orders/${orderId}`, { session }).then(setTrace), [orderId, session]);
  if (!trace) return null;
  const o = trace.order;
  const Item = ({ k, children }: { k: string; children: ReactNode }) => (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
  return (
    <article className="card stack trace">
      <div className="row spread">
        <h2>
          Order {o.id.slice(0, 8)}: {o.buyer_name}
        </h2>
        <button className="ghost small" onClick={close}>
          Close
        </button>
      </div>
      <dl>
        <Item k="Event">{o.event_name}</Item>
        <Item k="Paid">
          {money(o.amount_cents, o.currency)} ({money(o.fee_cents, o.currency)} platform fee) · {o.status}
          {o.paid_at && ` · ${when(o.paid_at)}`}
        </Item>
        <Item k="Stripe">
          <span className="mono small">
            {o.stripe_checkout_session_id} · {o.stripe_payment_intent_id}
          </span>
        </Item>
      </dl>
      <h3>Tickets</h3>
      {trace.tickets.map((t) => (
        <p key={t.id} className="small">
          <span className="mono">{t.id.slice(0, 8)}</span> {t.type} {money(t.price_cents)} (fee {money(t.fee_cents)}) · {t.status}
          {t.refunded_cents > 0 && ` · ${money(t.refunded_cents)} refunded`}
        </p>
      ))}
      {trace.refunds.length > 0 && <h3>Refunds</h3>}
      {trace.refunds.map((r) => (
        <p key={r.id} className="small">
          {money(r.amount_cents)} · {r.reason.replaceAll("_", " ")} by {r.requested_by} · {r.status}
          {r.stripe_refund_id && <span className="mono"> · {r.stripe_refund_id}</span>}
          {r.note && ` · “${r.note}”`}
        </p>
      ))}
      {trace.disputes.length > 0 && <h3>Chargebacks</h3>}
      {trace.disputes.map((d) => (
        <p key={d.id} className="small">
          {money(d.amount_cents)} + {money(d.fee_cents)} fee · {d.reason} · {d.status} <span className="mono">· {d.stripe_dispute_id}</span>
        </p>
      ))}
      <h3>Ledger transfers ({trace.transfers.length})</h3>
      {trace.transfers.map((t) => (
        <div key={t.id} className="small">
          <span className="mono">{t.idempotency_key}</span> {t.memo && <span>· {t.memo}</span>}
          <div className="entries">
            {t.entries.map((e, i) => (
              <span key={i}>
                {e.account} {money(e.amount_cents)}
                {i < t.entries.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function DemoPanel({ session, bankControls, onDone }: { session: Session; bankControls: boolean; onDone: () => Promise<void> }) {
  const [outage, setOutage] = useState<boolean | null>(null);
  const { busy, error, run } = useAction(onDone);
  useEffect(() => {
    if (bankControls) void call<{ behaviour: { outage: boolean } }>("GET", "/organizer/demo/bank", { session }).then((r) => setOutage(r.behaviour.outage), () => {});
  }, [bankControls, session]);
  return (
    <section className="card demo">
      <div className="panel-head">
        <h2>Demo controls</h2>
        <span className="muted small">DEMO_MODE only</span>
      </div>
      <div className="switches">
        {bankControls && outage !== null && (
          <div className="switch-row">
            <button
              className={`switch ${outage ? "on" : ""}`}
              aria-pressed={outage}
              aria-label="Bank connector down"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await call<{ behaviour: { outage: boolean } }>("POST", "/organizer/demo/bank", { session, body: { outage: !outage } });
                  setOutage(r.behaviour.outage);
                })
              }
            >
              <span className="knob" />
            </button>
            <div>
              <div className="title">Bank connector down</div>
              <div className="muted small">Every call to the bank fails with 503. Payouts wait, and are retried with the same idempotency key.</div>
            </div>
          </div>
        )}
        <div className="row">
          <button className="small ghost" disabled={busy} onClick={() => void run(() => call("POST", "/organizer/demo/run-schedule", { session }))}>
            Run the payout schedule now
          </button>
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

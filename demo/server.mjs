// Disposable demo "staging" app with deliberately planted bugs, for exercising the explorer.
// Every bug is tagged PLANTED so it is easy to see what the suite should find.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4173);
const products = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `Widget ${i + 1}`, price: 10 + i * 5 }));
const orders = [];
let dangerousHits = 0;

const nav = `<nav><a href="/">Home</a> · <a href="/products">Products</a> · <a href="/search">Search</a> ·
  <a href="/orders/new">New order</a> · <a href="/orders">Orders</a> · <a href="/settings">Settings</a> ·
  <a href="/assistant">Assistant</a> · <a href="/help">Help</a></nav>`;

const layout = (title, body, { withNav = true } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://cdn.example.com/theme.css"></head>
<body>${withNav ? nav : ""}<main><h1>${title}</h1>${body}</main></body></html>`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function readForm(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

const routes = {
  "GET /": () =>
    layout("Demo shop", `<p>Welcome. Browse products or place an order.</p>
      <a href="/account/delete">Delete account</a> · <a href="/logout">Sign out</a>`),

  "GET /products": () =>
    layout("Products", `<ul>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a> — $${p.price}</li>`).join("")}</ul>
      <!-- PLANTED: a promo banner covers the navigation until dismissed. -->
      <div id="promo" style="position:fixed;top:0;left:0;right:0;height:48px;background:#ffe;display:flex;align-items:center;gap:8px;padding:0 12px">
        Spring sale! <button aria-label="Dismiss promo" onclick="this.parentElement.remove()">×</button></div>`),

  "GET /products/:id": (_req, { id }) => {
    const product = products.find((p) => p.id === Number(id));
    if (Number(id) === 7) {
      // PLANTED: raw stack trace shown to the end user, with a 500.
      return [500, layout("Error", `<pre>TypeError: Cannot read properties of undefined (reading 'price')
    at renderProduct (/srv/app/src/views/product.js:42:17)
    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)</pre>`)];
    }
    if (!product) return [404, layout("Not found", "<p>No such product.</p>")];
    return layout(product.name, `<p>Price: $${product.price}</p>
      <form method="post" action="/orders"><input type="hidden" name="product" value="${product.id}">
      <label>Quantity <input name="quantity" type="number" value="1"></label>
      <button type="submit">Add to order</button></form>`);
  },

  "GET /search": (req) => {
    const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
    const hits = products.filter((p) => q && p.name.toLowerCase().includes(q.toLowerCase()));
    // PLANTED: heading always claims 12 results; query reflected without escaping (XSS).
    const results = q
      ? `<h2>Showing 12 results for ${q}</h2><ul>${hits.map((p) => `<li>${p.name}</li>`).join("")}</ul>`
      : "";
    return layout("Search", `<form><label>Query <input name="q" type="search" value="${escape(q)}"></label>
      <button>Search</button></form>${results}`);
  },

  "GET /orders/new": () =>
    layout("New order", `<form method="post" action="/orders">
      <label>Name <input name="name" required></label>
      <label>Email <input name="email" type="email"></label>
      <label>Product <select name="product">${products.map((p) => `<option value="${p.id}">${p.name}</option>`).join("")}</select></label>
      <label>Quantity <input name="quantity" type="number" value="1"></label>
      <button type="submit">Place order</button></form>`),

  "POST /orders": async (req) => {
    const form = await readForm(req);
    // PLANTED: long names crash the handler.
    if ((form.name ?? "").length > 100) throw new Error("value too long for column \"name\" (varchar(100))");
    // PLANTED: no idempotency, double submits create duplicate orders.
    orders.push({ id: orders.length + 1, name: form.name || "(no name)", product: form.product, quantity: form.quantity });
    return layout("Order placed", `<p>Order #${orders.length} placed.</p><a href="/orders">View orders</a>`);
  },

  "GET /orders": () =>
    layout("Orders", orders.length
      ? `<ul>${orders.map((o) => `<li><a href="/orders/${o.id}">Order #${o.id}</a> — ${escape(o.name)}</li>`).join("")}</ul>`
      // PLANTED: error message with no way to recover.
      : `<p class="error">ERR_EMPTY_COLLECTION</p>`),

  "GET /orders/:id": (_req, { id }) => {
    const order = orders.find((o) => o.id === Number(id));
    if (!order) return [404, layout("Not found", "<p>Order not found.</p>")];
    return layout(`Order #${order.id}`, `<p>${escape(order.name)}: ${order.quantity} × product ${order.product}</p>`);
  },

  "GET /settings": () =>
    layout("Settings", `<div role="tablist">
        <button role="tab" onclick="show('profile')">Profile</button>
        <button role="tab" onclick="show('notifications')">Notifications</button></div>
      <section id="profile"><label>Display name <input name="display"></label>
        <button id="save">Save</button></section>
      <section id="notifications" hidden><h2>settings.notifications.title</h2>
        <p>settings.notifications.description</p></section>
      <script>
        function show(id) { for (const s of document.querySelectorAll('section')) s.hidden = s.id !== id; }
        // PLANTED: Save handler references an undefined function; the button visibly does nothing.
        document.getElementById('save').addEventListener('click', () => saveProfile());
        fetch('/api/preferences');
      </script>`),

  // PLANTED: preferences endpoint is missing.
  "GET /api/preferences": () => [404, "{}"],

  // A minimal login, for testing saved login sessions.
  "GET /login": () =>
    layout("Sign in", `<form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button></form>`),
  "POST /login": async (req) => {
    const form = await readForm(req);
    if (form.username !== "tester" || form.password !== "hunter2") return [401, layout("Sign in", "<p>Wrong username or password.</p>")];
    return [303, "", { "set-cookie": "demo_session=tester-session; Path=/; HttpOnly; Max-Age=86400", location: "/account" }];
  },
  "GET /account": (req) =>
    /demo_session=tester-session/.test(req.headers.cookie ?? "")
      ? layout("Your account", "<p>Signed in as tester.</p>")
      : [303, "", { location: "/login" }],

  // A slow AI-style assistant: it "thinks", then streams its answer over one long GET request.
  "GET /assistant": () =>
    layout("Assistant", `<form id="ask"><label>Message <input name="q" autocomplete="off"></label>
      <button type="submit">Send</button></form>
      <div id="log" aria-live="polite"></div>
      <script>
        document.getElementById("ask").addEventListener("submit", async (e) => {
          e.preventDefault();
          const q = e.target.q.value;
          const log = document.getElementById("log");
          const turn = document.createElement("div");
          turn.innerHTML = '<p class="you"></p><p class="typing" aria-busy="true">Thinking…</p><p class="answer"></p>';
          turn.querySelector(".you").textContent = "You: " + q;
          log.append(turn);
          const res = await fetch("/api/assistant?q=" + encodeURIComponent(q));
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          turn.querySelector(".typing").remove();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            turn.querySelector(".answer").textContent += decoder.decode(value);
          }
        });
      </script>`),
  "GET /api/assistant": (req) => ({
    stream: async (res) => {
      const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      // PLANTED: an empty message is never answered; the page shows "Thinking…" forever.
      if (!q.trim()) {
        const hang = setTimeout(() => res.end(), 120_000);
        req.on("close", () => clearTimeout(hang));
        return;
      }
      await new Promise((r) => setTimeout(r, 2_500));
      const words = `Thanks for asking about "${q.slice(0, 40)}". Here is a considered answer, streamed one word at a time the way AI assistants do. Answer complete.`.split(" ");
      for (const word of words) {
        if (res.destroyed) return;
        res.write(word + " ");
        await new Promise((r) => setTimeout(r, 250));
      }
      res.end();
    },
  }),

  // PLANTED: dead end, no navigation.
  "GET /help": () => layout("Help", "<p>Contact your administrator.</p>", { withNav: false }),

  "GET /account/delete": () => {
    dangerousHits++;
    console.error(`!!! SAFETY: /account/delete was reached (${dangerousHits}x)`);
    return layout("Account deleted", "<p>Your account is gone.</p>");
  },
  "GET /logout": () => {
    dangerousHits++;
    console.error(`!!! SAFETY: /logout was reached (${dangerousHits}x)`);
    return layout("Signed out", "<p>Bye.</p>");
  },
};

function match(method, path) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const hit = path.match(re);
    if (hit) return [handler, Object.fromEntries(names.map((n, i) => [n, hit[i + 1]]))];
  }
  return [];
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const [handler, params] = match(req.method, pathname);
  try {
    const out = handler ? await handler(req, params) : [404, layout("Not found", "<p>Nothing here.</p>")];
    if (out && typeof out.stream === "function") return await out.stream(res);
    const [status, body, headers = {}] = Array.isArray(out) ? out : [200, out];
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(`Internal Server Error\n\n${err.stack}`);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Demo app on http://127.0.0.1:${PORT}`));

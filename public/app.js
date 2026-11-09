const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginForm = document.querySelector("#login-form");
const toast = document.querySelector("#toast");
const state = { user: null, projects: [], clients: [], articles: [] };
const usdFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
let toastTimer;

document.querySelector("#year").textContent = new Date().getFullYear();

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
}

function showProjectSaveResult(action, notifications) {
  const message = `Project ${action}.`;
  if (!notifications || notifications.attempted === 0) {
    showToast(message);
  } else if (!notifications.configured) {
    showToast(`${message} Email is not configured; no client notifications were sent.`);
  } else if (notifications.failed > 0) {
    showToast(`${message} ${notifications.sent} of ${notifications.attempted} email notifications sent; check the server logs.`);
  } else {
    showToast(`${message} Email notifications sent to ${notifications.sent} client${notifications.sent === 1 ? "" : "s"}.`);
  }
}

function formatUsdCents(cents) {
  return cents == null ? "Amount not set" : usdFormatter.format(Number(cents) / 100);
}

function formatProjectDate(dateString) {
  if (!dateString) return "Not set";
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysInMonth(year, month) {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function calculateFinishDate(startDate, lengthMonths) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isSafeInteger(lengthMonths) || lengthMonths < 1) {
    return "";
  }
  const [year, month, day] = startDate.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return "";
  }
  const targetMonthIndex = month - 1 + lengthMonths;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  if (targetYear > 9999) return "";
  const targetMonth = (targetMonthIndex % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function updateExpectedFinishDate() {
  document.querySelector("#project-finish-date").value = calculateFinishDate(
    document.querySelector("#project-start-date").value,
    Number(document.querySelector("#project-length").value),
  );
}

function calculateProjection(project, amountCents) {
  if (
    !Number.isSafeInteger(amountCents) ||
    !Number.isSafeInteger(project.length_months) ||
    typeof project.annual_rate !== "number"
  ) {
    return null;
  }
  const earningsCents = Math.round(
    amountCents * (project.annual_rate / 100) * (project.length_months / 12),
  );
  return {
    investedCents: amountCents,
    earningsCents,
    totalCents: amountCents + earningsCents,
  };
}

function createInvestmentBlock(project, amountCents, clientName = null) {
  const block = document.createElement("section");
  block.className = "investment-block";

  if (clientName) {
    const heading = document.createElement("h4");
    heading.className = "investment-client-name";
    heading.textContent = clientName;
    block.append(heading);
  }

  const projection = calculateProjection(project, amountCents);
  if (!projection) {
    const unavailable = document.createElement("p");
    unavailable.className = "estimate-unavailable";
    unavailable.textContent = amountCents == null
      ? "Investment amount not set"
      : "Set project length and annual rate to see an estimate";
    block.append(unavailable);
    return block;
  }

  const metrics = document.createElement("div");
  metrics.className = "investment-metrics";
  for (const [label, cents, className] of [
    ["Invested", projection.investedCents, ""],
    ["Est. earnings", projection.earningsCents, "estimated-earnings"],
    ["Projected total", projection.totalCents, "projected-total"],
  ]) {
    const metric = document.createElement("div");
    metric.className = "investment-metric";
    const metricLabel = document.createElement("span");
    metricLabel.textContent = label;
    const value = document.createElement("strong");
    value.className = className;
    value.textContent = formatUsdCents(cents);
    metric.append(metricLabel, value);
    metrics.append(metric);
  }
  block.append(metrics);

  const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chart.setAttribute("class", "investment-chart");
  chart.setAttribute("viewBox", "0 0 320 108");
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `Illustrative simple-interest projection: ${formatUsdCents(projection.investedCents)} invested, ${formatUsdCents(projection.earningsCents)} estimated earnings, and ${formatUsdCents(projection.totalCents)} projected after ${project.length_months} months.`,
  );

  const svgElement = (name, attributes) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value);
    return element;
  };
  const left = 38;
  const right = 307;
  const top = 13;
  const bottom = 73;
  const total = Math.max(projection.totalCents, 1);
  const investmentY = bottom - (projection.investedCents / total) * (bottom - top);
  const endY = bottom - (projection.totalCents / total) * (bottom - top);
  chart.append(
    svgElement("line", { x1: left, y1: top, x2: right, y2: top, class: "chart-gridline" }),
    svgElement("line", { x1: left, y1: bottom, x2: right, y2: bottom, class: "chart-axis" }),
    svgElement("line", {
      x1: left,
      y1: investmentY,
      x2: right,
      y2: investmentY,
      class: "chart-investment-guide",
    }),
    svgElement("path", {
      d: `M ${left} ${investmentY} L ${right} ${endY} L ${right} ${investmentY} Z`,
      class: "chart-earnings-area",
    }),
    svgElement("path", {
      d: `M ${left} ${investmentY} L ${right} ${endY}`,
      class: "chart-projection-line",
    }),
  );

  const startLabel = svgElement("text", { x: left, y: 92, class: "chart-time-label" });
  startLabel.textContent = "Month 0";
  const endLabel = svgElement("text", { x: right, y: 92, class: "chart-time-label", "text-anchor": "end" });
  endLabel.textContent = `${project.length_months} months`;
  chart.append(startLabel, endLabel);

  const caption = document.createElement("p");
  caption.className = "chart-caption";
  caption.textContent = "Illustrative simple-interest estimate; excludes fees and taxes.";
  block.append(chart, caption);
  return block;
}

function setSignedIn(user) {
  state.user = user;
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  document.querySelector("#user-name").textContent = user.name;
  const isAdmin = user.role === "admin";
  document.querySelector("#admin-section").classList.toggle("hidden", !isAdmin);
  document.querySelector("#page-eyebrow").textContent = isAdmin ? "ADMINISTRATOR WORKSPACE" : "YOUR OVERVIEW";
  document.querySelector("#page-title").textContent = isAdmin ? "Portfolio overview" : "Your portfolio";
  document.querySelector("#page-description").textContent = isAdmin
    ? "Manage client access and keep project information up to date."
    : "A current view of the projects connected to your account.";
  document.querySelector("#projects-heading-title").textContent = isAdmin ? "All projects" : "Your projects";
  refreshDashboard().catch(showToast);
}

async function refreshDashboard() {
  const [projectResult, clientResult, newsResult] = await Promise.all([
    request("/api/projects"),
    state.user.role === "admin" ? request("/api/admin/clients") : Promise.resolve({ clients: [] }),
    request(state.user.role === "admin" ? "/api/admin/news" : "/api/news"),
  ]);
  state.projects = projectResult.projects;
  state.clients = clientResult.clients;
  state.articles = newsResult.articles;
  renderProjects();
  renderNews();
  if (state.user.role === "admin") {
    renderClients();
    renderClientPicker();
    renderCustomerProjects();
    renderAdminNews();
  }
}

function renderProjects() {
  const list = document.querySelector("#project-list");
  list.replaceChildren();
  document.querySelector("#project-count").textContent =
    `${state.projects.length} ${state.projects.length === 1 ? "project" : "projects"}`;
  document.querySelector("#empty-state").classList.toggle("hidden", state.projects.length > 0);

  for (const project of state.projects) {
    const card = document.createElement("article");
    card.className = "project-card";

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const status = document.createElement("span");
    status.className = `status status-${project.status.toLowerCase().replaceAll(" ", "-")}`;
    status.textContent = project.status;
    meta.append(status);
    if (state.user.role === "admin") {
      const assignments = document.createElement("span");
      assignments.className = "assignment-count";
      const count = project.clients.length;
      assignments.textContent = `${count} ${count === 1 ? "client" : "clients"}`;
      meta.append(assignments);
    }

    const title = document.createElement("h3");
    title.textContent = project.title;
    const terms = document.createElement("div");
    terms.className = "project-terms";
    const length = document.createElement("span");
    length.textContent = project.length_months == null
      ? "Length not set"
      : `${project.length_months} ${project.length_months === 1 ? "month" : "months"}`;
    const rate = document.createElement("span");
    rate.textContent = project.annual_rate == null
      ? "Annual rate not set"
      : `${Number(project.annual_rate).toLocaleString(undefined, { maximumFractionDigits: 2 })}% annual`;
    terms.append(length, rate);
    const dates = document.createElement("div");
    dates.className = "project-dates";
    const startDate = document.createElement("span");
    startDate.textContent = `Starts ${formatProjectDate(project.start_date)}`;
    const finishDate = document.createElement("span");
    finishDate.textContent = `Expected finish ${formatProjectDate(project.expected_finish_date)}`;
    dates.append(startDate, finishDate);
    const description = document.createElement("p");
    description.className = "project-description";
    description.textContent = project.description || "No project details have been added.";
    const updated = document.createElement("span");
    updated.className = "updated-label";
    updated.textContent = `UPDATED ${new Date(project.updated_at || project.created_at).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })}`;
    card.append(meta, title, terms, dates);
    if (state.user.role === "admin") {
      if (project.clients.length) {
        for (const client of project.clients) {
          card.append(createInvestmentBlock(project, client.amount_cents, client.name));
        }
      } else {
        const unassigned = document.createElement("p");
        unassigned.className = "estimate-unavailable";
        unassigned.textContent = "Assign a client to record an investment amount.";
        card.append(unassigned);
      }
    } else {
      card.append(createInvestmentBlock(project, project.amount_cents));
    }
    card.append(description, updated);

    if (state.user.role === "admin") {
      const actions = document.createElement("div");
      actions.className = "card-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = "Edit project";
      edit.addEventListener("click", () => beginEdit(project));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button text-danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteProject(project));
      actions.append(edit, remove);
      card.append(actions);
    }
    list.append(card);
  }
}

function renderClients() {
  const list = document.querySelector("#client-list");
  list.replaceChildren();
  document.querySelector("#client-count").textContent = `${state.clients.length}`;
  if (!state.clients.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "Client accounts you add will appear here.";
    list.append(empty);
    return;
  }

  for (const client of state.clients) {
    const row = document.createElement("div");
    row.className = "client-row";
    const info = document.createElement("div");
    info.className = "client-info";
    const name = document.createElement("strong");
    name.textContent = client.name;
    const email = document.createElement("span");
    email.textContent = client.email;
    info.append(name, email);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.setAttribute("aria-label", `Remove ${client.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteClient(client));
    row.append(info, remove);
    list.append(row);
  }
}

function renderCustomerProjects() {
  const list = document.querySelector("#customer-project-list");
  list.replaceChildren();

  const assignedProjectCount = state.clients.reduce(
    (count, client) => count + state.projects.filter((project) =>
      project.clients.some((assignedClient) => assignedClient.id === client.id),
    ).length,
    0,
  );
  document.querySelector("#customer-project-count").textContent =
    `${assignedProjectCount} ${assignedProjectCount === 1 ? "assignment" : "assignments"}`;

  if (!state.clients.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "Add a customer account to see their assigned projects here.";
    list.append(empty);
    return;
  }

  for (const client of state.clients) {
    const card = document.createElement("article");
    card.className = "customer-project-card";

    const customer = document.createElement("div");
    customer.className = "customer-project-customer";
    const name = document.createElement("strong");
    name.textContent = client.name;
    const email = document.createElement("span");
    email.textContent = client.email;
    customer.append(name, email);

    const projects = document.createElement("div");
    projects.className = "customer-project-items";
    const assignedProjects = state.projects.filter((project) =>
      project.clients.some((assignedClient) => assignedClient.id === client.id),
    );
    if (assignedProjects.length) {
      for (const project of assignedProjects) {
        const projectItem = document.createElement("div");
        projectItem.className = "customer-project-item";
        const title = document.createElement("span");
        title.className = "customer-project-title";
        title.textContent = `${project.title} · ${formatProjectDate(project.start_date)} – ${formatProjectDate(project.expected_finish_date)} · ${project.length_months == null ? "Length not set" : `${project.length_months} mo`} · ${project.annual_rate == null ? "Rate not set" : `${Number(project.annual_rate).toLocaleString(undefined, { maximumFractionDigits: 2 })}%/yr`}`;
        const amount = document.createElement("span");
        amount.className = "customer-investment-amount";
        const assignedClient = project.clients.find((projectClient) => projectClient.id === client.id);
        const projection = calculateProjection(project, assignedClient.amount_cents);
        amount.textContent = projection
          ? `${formatUsdCents(projection.investedCents)} invested · ${formatUsdCents(projection.earningsCents)} estimated earnings`
          : formatUsdCents(assignedClient.amount_cents);
        const status = document.createElement("span");
        status.className = `status status-${project.status.toLowerCase().replaceAll(" ", "-")}`;
        status.textContent = project.status;
        projectItem.append(title, amount, status);
        projects.append(projectItem);
      }
    } else {
      const empty = document.createElement("span");
      empty.className = "customer-no-projects";
      empty.textContent = "No projects assigned";
      projects.append(empty);
    }

    card.append(customer, projects);
    list.append(card);
  }
}

function formatNewsDate(dateString) {
  if (!dateString) return "";
  const date = new Date(`${dateString.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderNews() {
  const list = document.querySelector("#news-list");
  list.replaceChildren();
  const publishedArticles = state.articles.filter((article) => article.is_published === undefined || article.is_published === 1);
  document.querySelector("#news-count").textContent =
    `${publishedArticles.length} ${publishedArticles.length === 1 ? "update" : "updates"}`;
  document.querySelector("#news-empty-state").classList.toggle("hidden", publishedArticles.length > 0);

  for (const article of publishedArticles) {
    const card = document.createElement("article");
    card.className = "news-card";
    const date = document.createElement("span");
    date.className = "news-date";
    date.textContent = formatNewsDate(article.published_at);
    const title = document.createElement("h3");
    title.textContent = article.title;
    const content = document.createElement("p");
    content.className = "news-content";
    content.textContent = article.content;
    card.append(date, title, content);
    list.append(card);
  }
}

function renderAdminNews() {
  const list = document.querySelector("#admin-news-list");
  list.replaceChildren();
  if (!state.articles.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "News you create will appear here.";
    list.append(empty);
    return;
  }

  for (const article of state.articles) {
    const row = document.createElement("article");
    row.className = "admin-news-row";
    const info = document.createElement("div");
    info.className = "admin-news-info";
    const title = document.createElement("strong");
    title.textContent = article.title;
    const status = document.createElement("span");
    status.className = article.is_published ? "news-status news-status-published" : "news-status";
    status.textContent = article.is_published ? "Published" : "Draft";
    info.append(title, status);
    const actions = document.createElement("div");
    actions.className = "admin-news-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "text-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => beginNewsEdit(article));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button text-danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteNews(article));
    actions.append(edit, remove);
    row.append(info, actions);
    list.append(row);
  }
}

function beginNewsEdit(article) {
  document.querySelector("#news-id").value = article.id;
  document.querySelector("#news-title").value = article.title;
  document.querySelector("#news-content").value = article.content;
  document.querySelector("#news-published").checked = Boolean(article.is_published);
  document.querySelector("#news-form-heading").textContent = "Edit news article";
  document.querySelector("#news-submit-label").textContent = article.is_published ? "Save changes" : "Save draft";
  document.querySelector("#cancel-news-edit").classList.remove("hidden");
  document.querySelector("#news-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetNewsForm() {
  document.querySelector("#news-form").reset();
  document.querySelector("#news-id").value = "";
  document.querySelector("#news-form-heading").textContent = "Add a news article";
  document.querySelector("#news-submit-label").textContent = "Publish news";
  document.querySelector("#cancel-news-edit").classList.add("hidden");
  document.querySelector("#news-error").textContent = "";
}

async function deleteNews(article) {
  if (!window.confirm(`Delete the news article “${article.title}”?`)) return;
  try {
    await request(`/api/admin/news/${article.id}`, { method: "DELETE" });
    await refreshDashboard();
    showToast("News article deleted.");
  } catch (error) {
    showToast(error.message);
  }
}

function renderClientPicker(selectedClients = []) {
  const list = document.querySelector("#client-picker-list");
  list.replaceChildren();
  if (!state.clients.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Add a client account first.";
    list.append(empty);
    return;
  }
  for (const client of state.clients) {
    const assignment = selectedClients.find((selected) => selected.id === client.id);
    const row = document.createElement("div");
    row.className = "client-investment-row";
    const label = document.createElement("label");
    label.className = "checkbox-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "clientId";
    checkbox.value = client.id;
    checkbox.checked = Boolean(assignment);
    const text = document.createElement("span");
    text.textContent = client.name;
    label.append(checkbox, text);

    const email = document.createElement("span");
    email.className = "client-investment-email";
    email.textContent = client.email;

    const amountLabel = document.createElement("label");
    amountLabel.className = "client-investment-input";
    const amountText = document.createElement("span");
    amountText.textContent = "Invested (USD)";
    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.max = "999999999.99";
    amountInput.step = "0.01";
    amountInput.inputMode = "decimal";
    amountInput.className = "client-investment-amount-input";
    amountInput.dataset.clientId = String(client.id);
    amountInput.setAttribute("aria-label", `${client.name} amount invested in USD`);
    amountInput.value = assignment ? (assignment.amount_cents / 100).toFixed(2) : "";
    amountInput.disabled = !assignment;
    amountInput.required = Boolean(assignment);
    checkbox.addEventListener("change", () => {
      amountInput.disabled = !checkbox.checked;
      amountInput.required = checkbox.checked;
    });
    amountLabel.append(amountText, amountInput);
    row.append(label, email, amountLabel);
    list.append(row);
  }
}

function beginEdit(project) {
  document.querySelector("#project-id").value = project.id;
  document.querySelector("#project-title").value = project.title;
  document.querySelector("#project-length").value = project.length_months ?? "";
  document.querySelector("#project-start-date").value = project.start_date ?? "";
  document.querySelector("#project-finish-date").value = project.expected_finish_date ?? "";
  document.querySelector("#project-rate").value = project.annual_rate ?? "";
  document.querySelector("#project-description").value = project.description;
  document.querySelector("#project-status").value = project.status;
  renderClientPicker(project.clients);
  document.querySelector("#project-form-title").textContent = "Edit project";
  document.querySelector("#project-form button[type=submit]").firstChild.textContent = "Save changes ";
  document.querySelector("#cancel-edit").classList.remove("hidden");
  document.querySelector("#project-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetProjectForm() {
  document.querySelector("#project-form").reset();
  document.querySelector("#project-id").value = "";
  document.querySelector("#project-form-title").textContent = "Add a project";
  document.querySelector("#project-form button[type=submit]").firstChild.textContent = "Save project ";
  document.querySelector("#cancel-edit").classList.add("hidden");
  updateExpectedFinishDate();
  renderClientPicker();
}

document.querySelector("#project-start-date").addEventListener("input", updateExpectedFinishDate);
document.querySelector("#project-length").addEventListener("input", updateExpectedFinishDate);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#login-error");
  error.textContent = "";
  const form = new FormData(loginForm);
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    loginForm.reset();
    setSignedIn(result.user);
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST" });
    state.user = null;
    dashboardView.classList.add("hidden");
    loginView.classList.remove("hidden");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#client-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#client-error");
  message.textContent = "";
  const values = new FormData(form);
  try {
    await request("/api/admin/clients", {
      method: "POST",
      body: JSON.stringify({
        name: values.get("name"),
        email: values.get("email"),
        password: values.get("password"),
      }),
    });
    form.reset();
    await refreshDashboard();
    showToast("Client account added.");
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#project-id").value;
  const message = document.querySelector("#project-error");
  message.textContent = "";
  const body = {
    title: document.querySelector("#project-title").value,
    description: document.querySelector("#project-description").value,
    lengthMonths: Number(document.querySelector("#project-length").value),
    startDate: document.querySelector("#project-start-date").value,
    annualRate: Number(document.querySelector("#project-rate").value),
    status: document.querySelector("#project-status").value,
    clientInvestments: [...document.querySelectorAll('input[name="clientId"]:checked')].map((checkbox) => {
      const amountInput = document.querySelector(`.client-investment-amount-input[data-client-id="${checkbox.value}"]`);
      return {
        clientId: Number(checkbox.value),
        amountCents: Math.round(Number(amountInput.value) * 100),
      };
    }),
  };
  try {
    const result = await request(id ? `/api/admin/projects/${id}` : "/api/admin/projects", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    resetProjectForm();
    await refreshDashboard();
    showProjectSaveResult(id ? "updated" : "added", result.notifications);
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#cancel-edit").addEventListener("click", resetProjectForm);

document.querySelector("#news-published").addEventListener("change", (event) => {
  document.querySelector("#news-submit-label").textContent = event.currentTarget.checked
    ? (document.querySelector("#news-id").value ? "Save changes" : "Publish news")
    : "Save draft";
});

document.querySelector("#news-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#news-id").value;
  const message = document.querySelector("#news-error");
  message.textContent = "";
  const body = {
    title: document.querySelector("#news-title").value,
    content: document.querySelector("#news-content").value,
    isPublished: document.querySelector("#news-published").checked,
  };
  try {
    await request(id ? `/api/admin/news/${id}` : "/api/admin/news", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    resetNewsForm();
    await refreshDashboard();
    showToast(id ? "News article updated." : body.isPublished ? "News published." : "Draft saved.");
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#cancel-news-edit").addEventListener("click", resetNewsForm);

async function deleteProject(project) {
  if (!window.confirm(`Delete “${project.title}” and remove it from all client portfolios?`)) return;
  try {
    await request(`/api/admin/projects/${project.id}`, { method: "DELETE" });
    await refreshDashboard();
    showToast("Project deleted.");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteClient(client) {
  if (!window.confirm(`Remove ${client.name}'s account? They will lose access to assigned projects.`)) return;
  try {
    await request(`/api/admin/clients/${client.id}`, { method: "DELETE" });
    await refreshDashboard();
    showToast("Client account removed.");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#password-toggle").addEventListener("click", () => {
  const section = document.querySelector("#password-section");
  section.classList.toggle("hidden");
  if (!section.classList.contains("hidden")) section.scrollIntoView({ behavior: "smooth", block: "center" });
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#password-message");
  message.className = "form-error";
  message.textContent = "";
  try {
    const result = await request("/api/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: document.querySelector("#current-password").value,
        newPassword: document.querySelector("#new-password").value,
      }),
    });
    message.classList.add("form-success");
    message.textContent = result.message;
    event.currentTarget.reset();
  } catch (error) {
    message.textContent = error.message;
  }
});

request("/api/me")
  .then(({ user }) => setSignedIn(user))
  .catch((error) => {
    if (error.message !== "Please sign in to continue.") showToast(error.message);
  });

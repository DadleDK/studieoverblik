"use strict";

// Studieoverblik v15 engagement layer.
// This script is intentionally loaded after the original inline app script.
// It extends the existing vanilla feed without changing quiz data, the quiz
// engine, navigation, progression keys, lazy-loading constants or PWA setup.
(function () {
  const FEED_CARDS_KEY = "feed.cards.v1";
  const FEED_PREFS_KEY = "feed.preferences.v1";
  const FEED_SETTINGS_KEY = "feed.settings.v1";
  const FEED_DAILY_KEY = "dailyMix.v1";
  const FEED_PERFORMANCE_KEY = "feed.performance.v1";
  const MIX_TARGET = 5;
  const DAY_MS = 86400000;
  const ratingLabels = { known: "Kunne den", almost: "Næsten", practice: "Skal øves" };
  const ratingSelftest = { known: "kan", almost: "oeve", practice: "ikke" };
  const ratingNouns = { known: "sikre", almost: "næsten", practice: "skal øves" };
  let feedSettingsOpen = false;

  if (typeof curriculumFactPool !== "function" || typeof renderWeek !== "function") return;

  function readJSON(key, fallback) {
    if (typeof storageGetJSON === "function") return storageGetJSON(key, fallback);
    try {
      const raw = localStorage.getItem("studieoverblik." + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) { return fallback; }
  }

  function writeJSON(key, value) {
    if (typeof storageSetJSON === "function") return storageSetJSON(key, value);
    try { localStorage.setItem("studieoverblik." + key, JSON.stringify(value)); return true; }
    catch (error) { return false; }
  }

  function notify(message) {
    if (typeof toast === "function") toast(message);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stableHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function scoreNoise(id) {
    const seed = typeof factFeedSeed === "number" ? Math.floor(factFeedSeed * 1000000) : 1;
    return (stableHash(id + ":" + seed) % 1000) / 1000;
  }

  function daysSince(timestamp) {
    if (!timestamp) return Infinity;
    const then = Date.parse(timestamp);
    if (!Number.isFinite(then)) return Infinity;
    return Math.max(0, (Date.now() - then) / DAY_MS);
  }

  function todayKey() {
    return typeof todayISO === "function" ? todayISO() : new Date().toISOString().slice(0, 10);
  }

  function defaultDailyMix() {
    return { date: todayKey(), cards: {}, count: 0, known: 0, almost: 0, practice: 0, topics: {}, completed: false, continued: false };
  }

  function getDailyMix() {
    const current = readJSON(FEED_DAILY_KEY, defaultDailyMix());
    if (!current || current.date !== todayKey()) return defaultDailyMix();
    current.cards = current.cards || {};
    current.topics = current.topics || {};
    current.count = Object.keys(current.cards).length;
    current.known = Object.values(current.cards).filter(item => item.rating === "known").length;
    current.almost = Object.values(current.cards).filter(item => item.rating === "almost").length;
    current.practice = Object.values(current.cards).filter(item => item.rating === "practice").length;
    current.completed = current.completed || current.count >= MIX_TARGET;
    return current;
  }

  function setDailyMix(mix) { writeJSON(FEED_DAILY_KEY, mix); }
  function getCardStore() { return readJSON(FEED_CARDS_KEY, {}); }
  function setCardStore(value) { writeJSON(FEED_CARDS_KEY, value); }
  function getPreferences() { return readJSON(FEED_PREFS_KEY, {}); }
  function setPreferences(value) { writeJSON(FEED_PREFS_KEY, value); }
  function getPerformance() { return readJSON(FEED_PERFORMANCE_KEY, { subjects: {}, topics: {}, goals: {} }); }
  function setPerformance(value) { writeJSON(FEED_PERFORMANCE_KEY, value); }
  function getSettings() {
    const settings = readJSON(FEED_SETTINGS_KEY, { scope: "balanced", savedFirst: false });
    if (!settings || typeof settings !== "object") return { scope: "balanced", savedFirst: false };
    return { scope: settings.scope === "subject" ? "subject" : "balanced", savedFirst: settings.savedFirst === true };
  }
  function setSettings(settings) { writeJSON(FEED_SETTINGS_KEY, settings); }

  function topicKey(fact) { return fact.subjectId + "|" + fact.weekId; }
  function getWeekByFact(fact) { return typeof findSemesterWeek === "function" ? findSemesterWeek(fact.weekId) : null; }
  function goalForFact(fact) {
    const week = getWeekByFact(fact);
    if (!week || !fact.goalId) return null;
    return week.goals.find(goal => goal.id === fact.goalId) || null;
  }

  function inferCardType(q, week) {
    const text = [q.prompt, q.scenario, q.explanation, (q.tags || []).join(" "), week?.title].join(" ").toLowerCase();
    if (q.type === "tf") return "sandt/falsk";
    if (/beregn|udregn|formel|procent|moms|nøgletal|dækningsbidrag|rentabilitet|kr\.|ratio|likviditet/.test(text)) return "beregning";
    if (q.scenario || /case|virksomhed|kunde|marked|situation|eksempel/.test(text)) return "case";
    if (/model|matrix|matrice|swot|tows|pestel|porter|du-pont|bmc|vrio|kotter|hofstede|maslow|herzberg/.test(text)) return "model";
    if (/forklar|vurdér|anvend|analys|reflekt/.test(text)) return "refleksion";
    return "begreb";
  }

  const originalFactFromQuestion = factFromQuestion;
  factFromQuestion = function enhancedFactFromQuestion(q, week) {
    const fact = originalFactFromQuestion(q, week);
    if (!fact) return null;
    fact.goalId = q.goalId || null;
    fact.cardType = inferCardType(q, week);
    fact.tags = Array.isArray(q.tags) ? q.tags : [];
    fact.sourceLabel = q.sourceLabel || "";
    fact.rawType = q.type || "";
    return fact;
  };

  function firstVisitOrder(items) {
    const subjects = Object.keys(subjectCatalog || {});
    const groups = subjects.map(subjectId => items
      .filter(item => item.subjectId === subjectId)
      .sort((a, b) => (a.difficulty - b.difficulty) || scoreNoise(a.id) - scoreNoise(b.id)));
    const result = [];
    let pointer = 0;
    while (result.length < items.length) {
      let added = false;
      groups.forEach(group => {
        if (group[pointer]) { result.push(group[pointer]); added = true; }
      });
      if (!added) break;
      pointer++;
    }
    return result;
  }

  function buildLearningSignals(cardStore) {
    const signals = { goals: {}, weeks: {}, subjects: {} };
    function add(scope, id, amount) {
      if (!id) return;
      signals[scope][id] = (signals[scope][id] || 0) + amount;
    }
    allSemesterWeeks().forEach(week => {
      week.goals.forEach(goal => {
        const status = typeof currentStatus === "function" ? currentStatus(goal) : goal.status;
        if (status === "missing") add("goals", goal.id, 16);
        else if (status === "partly") add("goals", goal.id, 8);
        else if (status === "covered") add("goals", goal.id, -4);
        const self = typeof getSelftest === "function" ? getSelftest(goal.id) : null;
        if (self === "ikke") add("goals", goal.id, 18);
        else if (self === "oeve") add("goals", goal.id, 11);
        else if (self === "kan") add("goals", goal.id, -7);
      });
      const questions = typeof allQuizQuestions === "function" ? allQuizQuestions(week.id) : [];
      questions.forEach(question => {
        const result = typeof getQuizResult === "function" ? getQuizResult(question.id) : null;
        if (result === "incorrect") add("goals", question.goalId, 12);
        else if (result === "unsure") add("goals", question.goalId, 8);
        else if (result === "correct") add("goals", question.goalId, -4);
        const selfMark = typeof getSelfMark === "function" ? getSelfMark(question.id) : null;
        if (selfMark === "ikke") add("goals", question.goalId, 12);
        else if (selfMark === "oeve") add("goals", question.goalId, 8);
        else if (selfMark === "kan") add("goals", question.goalId, -4);
      });
    });
    Object.values(cardStore).forEach(entry => {
      if (!entry || !entry.goalId) return;
      if (entry.rating === "practice") add("goals", entry.goalId, 18);
      else if (entry.rating === "almost") add("goals", entry.goalId, 9);
      else if (entry.rating === "known") add("goals", entry.goalId, -6);
    });
    Object.entries(signals.goals).forEach(([goalId, value]) => {
      const week = allSemesterWeeks().find(item => item.goals.some(goal => goal.id === goalId));
      if (!week) return;
      add("weeks", week.id, value * 0.5);
      add("subjects", week.subjectId, value * 0.25);
    });
    return signals;
  }

  function reasonForFact(fact, cardState, preferences, signals) {
    const pref = preferences[topicKey(fact)] || {};
    if (cardState?.saved) return "Du har gemt dette kort til senere.";
    if (pref.more > pref.less) return "Du har bedt om mere fra dette emne.";
    if (!cardState?.seenCount) return "Du har ikke set dette kort før.";
    if (cardState.rating === "practice") return "Du har markeret dette emne som svært.";
    if ((signals.goals[fact.goalId] || 0) >= 15) return "Dine markeringer eller quizsvar peger på, at emnet bør repeteres.";
    if (daysSince(cardState.lastSeen) >= 6) return "En kort repetition fra sidste uge.";
    if (fact.subjectId !== activeSubjectId) return "Noget nyt fra et andet dækket emne.";
    return "Noget nyt fra dit pensum.";
  }

  function rankFactItems(items) {
    const cardStore = getCardStore();
    const preferences = getPreferences();
    const settings = getSettings();
    const signals = buildLearningSignals(cardStore);
    const hasHistory = Object.keys(cardStore).length > 0 || Object.keys(preferences).length > 0 || Object.values(signals.goals).some(value => value !== 0);
    const visible = items.filter(fact => !cardStore[fact.id]?.hidden);
    const pool = visible.length ? visible : items;
    if (!hasHistory) return firstVisitOrder(pool);

    const enriched = pool.map(fact => {
      const cardState = cardStore[fact.id] || {};
      const pref = preferences[topicKey(fact)] || {};
      const goalScore = signals.goals[fact.goalId] || 0;
      const weekScore = signals.weeks[fact.weekId] || 0;
      const subjectScore = signals.subjects[fact.subjectId] || 0;
      const gap = daysSince(cardState.lastSeen || cardState.lastShown);
      let score = 20 + goalScore + weekScore * 0.25 + subjectScore * 0.12;
      if (settings.savedFirst && cardState.saved) score += 45;
      if (fact.subjectId === activeSubjectId) score += settings.scope === "subject" ? 18 : 6;
      else if (settings.scope === "subject") score -= 16;
      if (!cardState.seenCount) score += 22;
      else if (gap >= 7) score += 16;
      else if (gap >= 2) score += 7;
      else score -= 12;
      if (cardState.rating === "practice") score += 24;
      else if (cardState.rating === "almost") score += 12;
      else if (cardState.rating === "known") score -= 10;
      score += (pref.more || 0) * 14 - (pref.less || 0) * 18;
      score += scoreNoise(fact.id) * 9;
      const reason = reasonForFact(fact, cardState, preferences, signals);
      return { fact, score, reason, cardState, goalScore, gap, pref };
    }).sort((a, b) => b.score - a.score);

    const buckets = {
      relevant: enriched.filter(item => item.goalScore >= 12 || item.cardState.rating === "practice" || (item.pref.more || 0) > (item.pref.less || 0)),
      repetition: enriched.filter(item => item.cardState.seenCount && item.gap >= 2),
      fresh: enriched.filter(item => !item.cardState.seenCount),
      surprise: enriched.filter(item => item.fact.subjectId !== activeSubjectId || item.goalScore < 8),
    };
    const pattern = ["relevant", "relevant", "relevant", "relevant", "relevant", "repetition", "repetition", "fresh", "fresh", "surprise"];
    const used = new Set();
    const output = [];
    let guard = 0;
    while (output.length < enriched.length && guard < enriched.length * 3) {
      const key = pattern[guard % pattern.length];
      const candidate = buckets[key].find(item => !used.has(item.fact.id)) || enriched.find(item => !used.has(item.fact.id));
      if (candidate) { used.add(candidate.fact.id); output.push(candidate); }
      guard++;
    }
    return output.map(item => Object.assign({}, item.fact, { why: item.reason, rankScore: item.score }));
  }

  function markShown(ids) {
    if (!ids.length) return;
    const cards = getCardStore();
    const now = new Date().toISOString();
    let changed = false;
    ids.forEach(id => {
      if (!id) return;
      cards[id] = cards[id] || {};
      cards[id].lastShown = now;
      cards[id].shownCount = (cards[id].shownCount || 0) + 1;
      changed = true;
    });
    if (changed) setCardStore(cards);
  }

  function findFactById(id) { return (factFeedItems || []).find(fact => fact.id === id); }

  function updatePerformance(fact, rating) {
    const perf = getPerformance();
    const now = new Date().toISOString();
    const delta = rating === "known" ? 1 : rating === "almost" ? 0.5 : -1;
    [
      ["subjects", fact.subjectId],
      ["topics", topicKey(fact)],
      ["goals", fact.goalId],
    ].forEach(([scope, id]) => {
      if (!id) return;
      perf[scope] = perf[scope] || {};
      const entry = perf[scope][id] || { score: 0, known: 0, almost: 0, practice: 0, lastAt: null };
      entry.score = Math.max(-20, Math.min(20, (entry.score || 0) + delta));
      entry[rating] = (entry[rating] || 0) + 1;
      entry.lastAt = now;
      perf[scope][id] = entry;
    });
    setPerformance(perf);
  }

  function recordRating(fact, rating) {
    const cards = getCardStore();
    const previous = cards[fact.id] || {};
    const now = new Date().toISOString();
    cards[fact.id] = Object.assign({}, previous, {
      revealed: true,
      rating,
      lastSeen: now,
      seenCount: (previous.seenCount || 0) + (previous.rating ? 0 : 1),
      subjectId: fact.subjectId,
      weekId: fact.weekId,
      goalId: fact.goalId || null,
      topic: fact.topic,
      cardType: fact.cardType,
    });
    setCardStore(cards);
    updatePerformance(fact, rating);

    const mix = getDailyMix();
    const firstToday = !mix.cards[fact.id];
    mix.cards[fact.id] = { rating, topic: fact.topic, subjectId: fact.subjectId };
    mix.topics[fact.topic] = (mix.topics[fact.topic] || 0) + (firstToday ? 1 : 0);
    mix.count = Object.keys(mix.cards).length;
    mix.known = Object.values(mix.cards).filter(item => item.rating === "known").length;
    mix.almost = Object.values(mix.cards).filter(item => item.rating === "almost").length;
    mix.practice = Object.values(mix.cards).filter(item => item.rating === "practice").length;
    if (mix.count >= MIX_TARGET) mix.completed = true;
    setDailyMix(mix);
    if (firstToday && typeof logCompletion === "function") logCompletion();

    const verb = rating === "known" ? "styrkede" : rating === "almost" ? "nærmede dig" : "fandt et øvepunkt i";
    notify(rating === "practice" ? `Gemt som øvepunkt: ${fact.topic}` : `Du ${verb} ${fact.topic}`);
  }

  function setTopicPreference(fact, direction) {
    const prefs = getPreferences();
    const key = topicKey(fact);
    prefs[key] = prefs[key] || { more: 0, less: 0, saved: 0 };
    prefs[key][direction] = (prefs[key][direction] || 0) + 1;
    prefs[key].subjectId = fact.subjectId;
    prefs[key].weekId = fact.weekId;
    prefs[key].topic = fact.topic;
    prefs[key].updatedAt = new Date().toISOString();
    setPreferences(prefs);
    notify(direction === "more" ? "Du får mere fra dette emne fremover." : "Du får mindre fra dette emne fremover.");
  }

  function setCardFlag(fact, flag, value) {
    const cards = getCardStore();
    cards[fact.id] = Object.assign({}, cards[fact.id] || {}, {
      subjectId: fact.subjectId,
      weekId: fact.weekId,
      goalId: fact.goalId || null,
      topic: fact.topic,
      cardType: fact.cardType,
    });
    cards[fact.id][flag] = value;
    cards[fact.id].updatedAt = new Date().toISOString();
    setCardStore(cards);
  }

  function feedSummaryText() {
    const cards = getCardStore();
    const practiceTopics = new Set(Object.values(cards).filter(item => item.rating === "practice").map(item => item.topic).filter(Boolean));
    const mix = getDailyMix();
    if (practiceTopics.size) return `${practiceTopics.size} emner er klar til repetition`;
    if (mix.count) return `${mix.count} aktive svar i dag`;
    return "Start med fem korte kort";
  }

  function learningProgressText() {
    const mix = getDailyMix();
    return `${Math.min(mix.count, MIX_TARGET)} af ${MIX_TARGET} i dagens mix`;
  }

  function topTopics(mix) {
    return Object.entries(mix.topics || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([topic]) => topic);
  }

  function mixSummaryMarkup() {
    const mix = getDailyMix();
    if (!mix.completed || mix.continued) return "";
    const topics = topTopics(mix);
    return `<aside class="daily-mix-summary" role="status" aria-live="polite">
      <div class="daily-mix-kicker">Dagens mix</div>
      <h3>${mix.count} kort gennemgået</h3>
      <div class="daily-mix-stats">
        <span>${mix.known} kunne</span>
        <span>${mix.almost} næsten</span>
        <span>${mix.practice} skal øves</span>
      </div>
      ${topics.length ? `<p>Du styrkede ${topics.map(escapeHtml).join(", ")}.</p>` : `<p>Du fik aktiveret dagens pensum.</p>`}
      <button class="btn btn-primary" data-action="daily-mix-continue">Fortsæt feedet</button>
    </aside>`;
  }

  factCardMarkup = function enhancedFactCardMarkup(fact) {
    const cards = getCardStore();
    const state = cards[fact.id] || {};
    const revealed = state.revealed === true;
    const saved = state.saved === true;
    const rating = state.rating;
    const typeKey = String(fact.cardType || "begreb").replace("/", "-");
    const goal = goalForFact(fact);
    const goalText = goal ? goal.text : fact.topic;
    const why = fact.why || reasonForFact(fact, state, getPreferences(), buildLearningSignals(cards));
    return `<article class="fact-card fact-card-v15 type-${escapeHtml(typeKey)} ${revealed ? "is-revealed" : ""} ${rating ? "is-rated rating-" + escapeHtml(rating) : ""}" data-fact-id="${escapeHtml(fact.id)}" data-card-type="${escapeHtml(typeKey)}" tabindex="0" role="group" aria-label="Læringskort: ${escapeHtml(fact.prompt)}">
      <div class="fact-card-meta">
        <span class="fact-subject">${escapeHtml(fact.subject)}</span>
        <span class="fact-difficulty">Niveau ${escapeHtml(fact.difficulty)}</span>
      </div>
      <div class="fact-type-row"><span class="fact-type-label">${escapeHtml(fact.cardType || "Begreb")}</span>${saved ? `<span class="fact-saved-pill">Gemt</span>` : ""}</div>
      <div class="fact-question">${escapeHtml(fact.prompt)}</div>
      <button class="fact-show-btn" data-action="fact-show" aria-expanded="${revealed ? "true" : "false"}">${revealed ? "Svar vist" : "Tænk først — vis svar"}</button>
      <div class="fact-reveal-area" ${revealed ? "" : "hidden"}>
        <div class="fact-answer"><span class="fact-answer-label">Kort fortalt</span>${escapeHtml(fact.answer)}</div>
        ${fact.explanation ? `<div class="fact-explanation">${escapeHtml(fact.explanation)}</div>` : ""}
        <div class="fact-selfcheck" aria-label="Selvvurdering">
          ${Object.entries(ratingLabels).map(([value, label]) => `<button class="fact-rate-btn ${rating === value ? "active" : ""}" data-action="fact-rate" data-rating="${value}">${label}</button>`).join("")}
        </div>
        ${rating ? `<div class="fact-rating-note">Din egen markering: <strong>${ratingLabels[rating]}</strong> — ikke en automatisk rettelse.</div>` : `<div class="fact-rating-note">Markér først efter du har sammenlignet med svaret.</div>`}
      </div>
      <div class="fact-card-footer">
        <span class="fact-topic">${escapeHtml(fact.topic)}</span>
        <button class="fact-quiz-btn" data-action="fact-quiz" data-subject="${escapeHtml(fact.subjectId)}" data-week="${escapeHtml(fact.weekId)}">Quiz mig →</button>
      </div>
      <details class="fact-card-menu">
        <summary aria-label="Feedkontrol">•••</summary>
        <div class="fact-menu-panel">
          <button data-action="fact-more">Mere af dette</button>
          <button data-action="fact-less">Mindre af dette</button>
          <button data-action="fact-save">${saved ? "Fjern gemt" : "Gem til senere"}</button>
          <button data-action="fact-hide">Skjul dette kort</button>
          <button data-action="fact-why">Hvorfor ser jeg dette?</button>
        </div>
      </details>
      <div class="fact-why-body" hidden>${escapeHtml(why)}${goalText ? `<small>${escapeHtml(goalText)}</small>` : ""}</div>
    </article>`;
  };

  renderFactFeed = function enhancedRenderFactFeed() {
    const rawPool = curriculumFactPool();
    factFeedItems = rankFactItems(rawPool);
    factFeedWindowStart = 0;
    factFeedRenderedCount = Math.min(FACT_FEED_INITIAL, factFeedItems.length);
    const cards = factFeedItems.slice(0, factFeedRenderedCount).map(factCardMarkup).join("");
    const settings = getSettings();
    const mix = getDailyMix();
    const progress = learningProgressText();
    return `<section class="card fact-feed fact-feed-v15 fade-in">
      <div class="fact-feed-head">
        <div class="feed-title-block">
          <div class="fact-feed-kicker">For dig</div>
          <h2>${feedSummaryText()}</h2>
          <p><span>${progress}</span><span>Dagens reelle læringsprogression</span></p>
        </div>
        <div class="feed-head-actions">
          <button class="btn fact-settings" data-action="fact-settings" aria-expanded="${feedSettingsOpen ? "true" : "false"}">Feed</button>
          <button class="btn fact-refresh" data-action="fact-refresh" aria-label="Ny blanding">↻</button>
        </div>
        <div class="fact-settings-panel" ${feedSettingsOpen ? "" : "hidden"}>
          <strong>Feedindstillinger</strong>
          <label><input type="radio" name="feedScope" value="balanced" ${settings.scope !== "subject" ? "checked" : ""}> Blandet pensum</label>
          <label><input type="radio" name="feedScope" value="subject" ${settings.scope === "subject" ? "checked" : ""}> Prioritér valgt fag</label>
          <label><input type="checkbox" data-action="feed-saved-first" ${settings.savedFirst ? "checked" : ""}> Gemte kort først</label>
        </div>
      </div>
      <div class="fact-feed-list">${cards}</div>
      <div class="fact-feed-progress" id="factFeedProgress">1 / ${factFeedItems.length} · ${Math.min(mix.count + 1, MIX_TARGET)} af ${MIX_TARGET}</div>
      ${mixSummaryMarkup()}
    </section>`;
  };

  function updateCardReveal(card, fact) {
    card.classList.add("is-revealed");
    const area = card.querySelector(".fact-reveal-area");
    if (area) area.hidden = false;
    const show = card.querySelector('[data-action="fact-show"]');
    if (show) { show.textContent = "Svar vist"; show.setAttribute("aria-expanded", "true"); }
    setCardFlag(fact, "revealed", true);
  }

  function updateCardRating(card, rating) {
    card.classList.remove("rating-known", "rating-almost", "rating-practice");
    card.classList.add("is-rated", "rating-" + rating);
    card.querySelectorAll('[data-action="fact-rate"]').forEach(btn => btn.classList.toggle("active", btn.dataset.rating === rating));
    const note = card.querySelector(".fact-rating-note");
    if (note) note.innerHTML = `Din egen markering: <strong>${ratingLabels[rating]}</strong> — ikke en automatisk rettelse.`;
  }

  function appendNextFactCards(feedList, amount) {
    if (!feedList || factFeedRenderedCount >= factFeedItems.length) return;
    const end = Math.min(factFeedItems.length, factFeedRenderedCount + amount);
    const html = factFeedItems.slice(factFeedRenderedCount, end).map(factCardMarkup).join("");
    feedList.insertAdjacentHTML("beforeend", html);
    markShown(factFeedItems.slice(factFeedRenderedCount, end).map(fact => fact.id));
    factFeedRenderedCount = end;
  }

  function trimFactDom(feedList, localIndex) {
    if (!feedList || feedList.children.length <= FACT_FEED_MAX_DOM || localIndex <= FACT_FEED_BATCH + 2) return;
    const removeCount = Math.min(FACT_FEED_BATCH, feedList.children.length - FACT_FEED_MAX_DOM);
    let removedHeight = 0;
    for (let i = 0; i < removeCount; i++) {
      const first = feedList.firstElementChild;
      if (!first) break;
      removedHeight += first.getBoundingClientRect().height;
      first.remove();
    }
    factFeedWindowStart += removeCount;
    feedList.scrollTop = Math.max(0, feedList.scrollTop - removedHeight);
  }

  function rerenderCurrentWeek() {
    const week = typeof selectedWeekNow === "function" ? selectedWeekNow() : weeks[0];
    if (!week) return;
    renderWeek(week);
    if (typeof setView === "function") setView(activeView || "today");
  }

  wireFactFeed = function enhancedWireFactFeed() {
    const feedList = document.querySelector(".fact-feed-list");
    const feedProgress = document.getElementById("factFeedProgress");
    if (feedList) markShown(Array.from(feedList.querySelectorAll(".fact-card")).map(card => card.dataset.factId));
    if (feedList && feedProgress) {
      let ticking = false;
      feedList.addEventListener("scroll", () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const height = Math.max(1, feedList.clientHeight);
          const localIndex = Math.max(0, Math.round(feedList.scrollTop / height));
          const currentIndex = Math.min(factFeedItems.length - 1, factFeedWindowStart + localIndex);
          const mix = getDailyMix();
          feedProgress.textContent = `${currentIndex + 1} / ${factFeedItems.length} · ${Math.min(mix.count + 1, MIX_TARGET)} af ${MIX_TARGET}`;
          if (feedList.scrollHeight - feedList.scrollTop - height < height * 3) appendNextFactCards(feedList, FACT_FEED_BATCH);
          trimFactDom(feedList, localIndex);
          ticking = false;
        });
      }, { passive: true });
    }

    document.querySelectorAll('[data-action="fact-refresh"]').forEach(btn => btn.addEventListener("click", () => {
      factFeedSeed = Math.random();
      rerenderCurrentWeek();
    }));
    document.querySelectorAll('[data-action="fact-settings"]').forEach(btn => btn.addEventListener("click", () => {
      feedSettingsOpen = !feedSettingsOpen;
      rerenderCurrentWeek();
    }));
    document.querySelectorAll('input[name="feedScope"]').forEach(input => input.addEventListener("change", () => {
      const settings = getSettings();
      settings.scope = input.value === "subject" ? "subject" : "balanced";
      setSettings(settings);
      factFeedSeed = Math.random();
      rerenderCurrentWeek();
    }));
    document.querySelectorAll('[data-action="feed-saved-first"]').forEach(input => input.addEventListener("change", () => {
      const settings = getSettings();
      settings.savedFirst = input.checked;
      setSettings(settings);
      rerenderCurrentWeek();
    }));
    document.querySelectorAll('[data-action="daily-mix-continue"]').forEach(btn => btn.addEventListener("click", () => {
      const mix = getDailyMix();
      mix.continued = true;
      setDailyMix(mix);
      rerenderCurrentWeek();
    }));

    if (!feedList) return;
    feedList.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest(".fact-card");
      if (!card || event.target.closest("button, summary, details, input, a")) return;
      const fact = findFactById(card.dataset.factId);
      if (!fact) return;
      event.preventDefault();
      updateCardReveal(card, fact);
    });
    feedList.addEventListener("click", event => {
      const actionEl = event.target.closest("[data-action]");
      const card = event.target.closest(".fact-card");
      if (!card) return;
      const fact = findFactById(card.dataset.factId);
      if (!fact) return;

      if (!actionEl) { updateCardReveal(card, fact); return; }
      const action = actionEl.dataset.action;
      if (action === "fact-show") {
        updateCardReveal(card, fact);
      } else if (action === "fact-rate") {
        updateCardReveal(card, fact);
        recordRating(fact, actionEl.dataset.rating);
        updateCardRating(card, actionEl.dataset.rating);
        const mix = getDailyMix();
        if (mix.completed && !mix.continued) rerenderCurrentWeek();
      } else if (action === "fact-more") {
        setTopicPreference(fact, "more");
      } else if (action === "fact-less") {
        setTopicPreference(fact, "less");
      } else if (action === "fact-save") {
        const current = getCardStore()[fact.id]?.saved === true;
        setCardFlag(fact, "saved", !current);
        notify(current ? "Kortet er fjernet fra gemte." : "Kortet er gemt til senere.");
        rerenderCurrentWeek();
      } else if (action === "fact-hide") {
        setCardFlag(fact, "hidden", true);
        notify("Kortet er skjult fra feedet.");
        card.classList.add("is-hiding");
        setTimeout(() => {
          card.remove();
          appendNextFactCards(feedList, 1);
        }, 120);
      } else if (action === "fact-why") {
        const why = card.querySelector(".fact-why-body");
        if (why) why.hidden = !why.hidden;
      } else if (action === "fact-quiz") {
        quizUI.mode = "basis";
        quizUI.exam = null;
        activateSubject(actionEl.dataset.subject, actionEl.dataset.week);
        setView("quiz");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  };

  rerenderCurrentWeek();
})();


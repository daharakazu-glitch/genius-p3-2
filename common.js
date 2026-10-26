// Shared speech helpers: TTS, recording + recognition, scoring, result rendering.

const VOICE_PRIORITY = [
    'Google US English', 'Google UK English Female', 'Microsoft Aria',
    'Microsoft Jenny', 'Microsoft Zira', 'Samantha', 'Karen', 'Moira', 'Tessa', 'Daniel', 'Alex'
];
let _voice = null;

function pickBestVoice() {
    const en = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
    if (!en.length) return null;
    for (const name of VOICE_PRIORITY) {
        const v = en.find(v => v.name.includes(name));
        if (v) return v;
    }
    return en.find(v => !v.localService) || en[0];
}

function getVoice() {
    if (!_voice) _voice = pickBestVoice();
    return _voice;
}

if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => { _voice = pickBestVoice(); };
}

// Speak a list of chunks in order. Each chunk: {text, pause(ms after)}.
// Returns a controller with cancel(); calls onend when finished (not when cancelled).
function speakChunks(chunks, rate, { onstart, onend, onchunk } = {}) {
    speechSynthesis.cancel();
    let idx = 0, cancelled = false, timer = null;
    function next() {
        if (cancelled) return;
        if (idx >= chunks.length) { onend && onend(); return; }
        const c = chunks[idx];
        const u = new SpeechSynthesisUtterance(c.text);
        const v = getVoice();
        if (v) u.voice = v;
        u.lang = 'en-US'; u.rate = rate; u.pitch = 1.0;
        u.onstart = () => { if (idx === 0 && onstart) onstart(); onchunk && onchunk(idx); };
        u.onend = () => {
            if (cancelled) return;
            idx++;
            timer = setTimeout(next, c.pause || 0);
        };
        u.onerror = () => { if (!cancelled) { cancelled = true; onend && onend(); } };
        speechSynthesis.speak(u);
    }
    next();
    return {
        cancel() { cancelled = true; clearTimeout(timer); speechSynthesis.cancel(); }
    };
}

function speakText(text, rate, handlers) {
    return speakChunks([{ text, pause: 0 }], rate, handlers);
}

function hasRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Microphone recorder: speech recognition + level analysis (volume, pauses).
class Recorder {
    constructor({ canvas } = {}) {
        this.canvas = canvas || null;
        this.active = false;
    }

    async start() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) throw new Error('no-sr');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);

        this.finalText = ''; this.interim = '';
        this.active = true;
        this.t0 = performance.now();
        this.firstVoice = null; this.lastVoice = null;
        this.levelSum = 0; this.levelN = 0;
        this.longPauses = 0; this.silenceStart = null;

        const make = () => {
            const r = new SR();
            r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
            r.onresult = e => {
                let interim = '';
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    if (e.results[i].isFinal) this.finalText += e.results[i][0].transcript + ' ';
                    else interim += e.results[i][0].transcript;
                }
                this.interim = interim;
            };
            r.onerror = e => {
                if (e.error === 'not-allowed') { this.active = false; alert('マイクの使用を許可してください。'); }
            };
            r.onend = () => {
                if (this.active) setTimeout(() => {
                    if (this.active) { this.recog = make(); try { this.recog.start(); } catch (_) {} }
                }, 150);
            };
            return r;
        };
        this.recog = make();
        try { this.recog.start(); } catch (_) {}
        this._loop();
    }

    _loop() {
        const buf = new Float32Array(this.analyser.fftSize);
        const freq = new Uint8Array(this.analyser.frequencyBinCount);
        const cv = this.canvas, g = cv ? cv.getContext('2d') : null;
        const frame = () => {
            if (!this.active) return;
            this.raf = requestAnimationFrame(frame);
            this.analyser.getFloatTimeDomainData(buf);
            let s = 0;
            for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
            const rms = Math.sqrt(s / buf.length);
            const now = performance.now();
            if (rms > 0.02) {
                if (this.firstVoice === null) this.firstVoice = now;
                if (this.silenceStart !== null && now - this.silenceStart > 1500) this.longPauses++;
                this.silenceStart = null;
                this.lastVoice = now;
                this.levelSum += rms; this.levelN++;
            } else if (this.firstVoice !== null && this.silenceStart === null) {
                this.silenceStart = now;
            }
            if (g) {
                this.analyser.getByteFrequencyData(freq);
                const n = 128, bw = cv.width / n;
                g.clearRect(0, 0, cv.width, cv.height);
                for (let i = 0; i < n; i++) {
                    const h = (freq[i] / 255) * cv.height;
                    g.fillStyle = `hsla(${38 + (freq[i] / 255) * 22},100%,64%,.85)`;
                    g.fillRect(i * bw, cv.height - h, bw - 1, h);
                }
            }
        };
        frame();
    }

    // Stops and resolves with {text, seconds, avgLevel, longPauses}.
    stop() {
        this.active = false;
        try { this.recog.onend = null; this.recog.stop(); } catch (_) {}
        if (this.raf) cancelAnimationFrame(this.raf);
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        if (this.ctx) this.ctx.close();
        if (this.canvas) this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
        const seconds = (this.firstVoice !== null && this.lastVoice !== null)
            ? (this.lastVoice - this.firstVoice) / 1000 : 0;
        return new Promise(res => setTimeout(() => res({
            text: (this.finalText + ' ' + this.interim).trim(),
            seconds,
            avgLevel: this.levelN ? this.levelSum / this.levelN : 0,
            longPauses: this.longPauses
        }), 500));
    }
}

// ---------- Scoring ----------
const CONTRACTIONS = {
    "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
    "it's": "it is", "that's": "that is", "there's": "there is", "he's": "he is",
    "they're": "they are", "they've": "they have", "we're": "we are", "let's": "let us",
    "don't": "do not", "doesn't": "does not", "didn't": "did not", "wasn't": "was not",
    "can't": "cannot", "won't": "will not", "isn't": "is not", "aren't": "are not"
};
const NUMBERS = { '1915': 'nineteen fifteen', '1975': 'nineteen seventy five', '1963': 'nineteen sixty three', '2018': 'twenty eighteen', '2003': 'two thousand three', '15': 'fifteen' };

function tokenize(text) {
    return text.toLowerCase()
        .replace(/[‘’ʼ]/g, "'")
        .replace(/(\d),(\d)/g, '$1$2')
        .replace(/-/g, ' ')
        .split(/\s+/)
        .map(w => w.replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, ''))
        .filter(w => w.length > 0)
        .flatMap(w => (CONTRACTIONS[w] || NUMBERS[w] || w).split(' '));
}

function lev(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

function fuzzy(a, b) {
    if (a === b) return true;
    if (a.length >= 4 && b.length >= 4) {
        const d = lev(a, b);
        if (d <= 1) return true;
        if (a.length >= 7 && b.length >= 5 && d <= 2) return true;
    }
    return false;
}

// LCS-based alignment between original and spoken text.
function compare(orig, spoken) {
    const ow = tokenize(orig), sw = tokenize(spoken || '');
    const m = ow.length, n = sw.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = fuzzy(ow[i - 1], sw[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const oSet = new Set(), sSet = new Set();
    let i = m, j = n;
    while (i > 0 && j > 0) {
        if (fuzzy(ow[i - 1], sw[j - 1]) && dp[i][j] === dp[i - 1][j - 1] + 1) { oSet.add(i - 1); sSet.add(j - 1); i--; j--; }
        else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
        else j--;
    }
    const matched = dp[m][n];
    return {
        pct: m ? Math.round(matched / m * 100) : 0,
        matched, missed: m - matched, extra: n - matched, spokenCount: n,
        origRes: ow.map((w, k) => ({ word: w, t: oSet.has(k) ? 'ok' : 'miss' })),
        spkRes: sw.map((w, k) => ({ word: w, t: sSet.has(k) ? 'ok' : 'xtra' }))
    };
}

function gradeMsg(pct) {
    if (pct >= 95) return '🌟 Excellent! Perfect speech!';
    if (pct >= 85) return '🎉 Great job! Almost perfect!';
    if (pct >= 70) return '👍 Good effort! Keep practicing!';
    if (pct >= 50) return '💪 Not bad! Try again!';
    if (pct >= 30) return '🔥 Keep going! Practice makes perfect!';
    return '📚 More practice needed! You can do it!';
}

function gradeColor(pct) {
    return pct >= 85 ? '#4caf50' : pct >= 55 ? '#ffd166' : '#ef5350';
}

// Delivery metrics → A/B/C (rough guide)
function deliveryRatings(rec, cmp) {
    const wpm = rec.seconds > 2 ? Math.round(cmp.spokenCount / (rec.seconds / 60)) : 0;
    const speed = !wpm ? '-' : (wpm >= 100 && wpm <= 170) ? 'A' : (wpm >= 80 && wpm <= 190) ? 'B' : 'C';
    const volume = rec.avgLevel >= 0.07 ? 'A' : rec.avgLevel >= 0.035 ? 'B' : 'C';
    const fluency = rec.longPauses <= 1 ? 'A' : rec.longPauses <= 3 ? 'B' : 'C';
    return { wpm, speed, volume, fluency };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CIRC = 565.5; // 2πr, r = 90

// Fill a standard result block. ids: prefix-based (arc, num, msg, stats, orig, spoken, section).
function renderResult(prefix, cmp, rec) {
    const $ = id => document.getElementById(prefix + id);
    const arc = $('arc');
    arc.style.strokeDashoffset = String(CIRC);
    setTimeout(() => {
        arc.style.strokeDashoffset = CIRC - CIRC * cmp.pct / 100;
        arc.style.stroke = gradeColor(cmp.pct);
    }, 80);
    $('num').textContent = cmp.pct + '%';
    $('msg').textContent = gradeMsg(cmp.pct);
    let html = `
        <div class="stat"><div class="stat-n" style="color:#a5d6a7">${cmp.matched}</div><div class="stat-d">Matched</div></div>
        <div class="stat"><div class="stat-n" style="color:#ef9a9a">${cmp.missed}</div><div class="stat-d">Missed</div></div>
        <div class="stat"><div class="stat-n" style="color:#ffcc80">${cmp.extra}</div><div class="stat-d">Extra</div></div>`;
    if (rec) {
        const d = deliveryRatings(rec, cmp);
        html += `
        <div class="stat"><div class="stat-n">${d.wpm || '-'}</div><div class="stat-d">WPM（速さ ${d.speed}）</div></div>
        <div class="stat"><div class="stat-n">${d.volume}</div><div class="stat-d">Volume（声量）</div></div>
        <div class="stat"><div class="stat-n">${d.fluency}</div><div class="stat-d">Fluency（長い沈黙 ${rec.longPauses}回）</div></div>`;
    }
    $('stats').innerHTML = html;
    const tok = items => items.map(x => `<span class="tok tok-${x.t}">${escapeHtml(x.word)}</span>`).join(' ');
    $('orig').innerHTML = tok(cmp.origRes) || '<span style="opacity:.35">—</span>';
    $('spoken').innerHTML = tok(cmp.spkRes) || '<span style="opacity:.35">音声が認識されませんでした</span>';
    const sec = $('section');
    sec.classList.add('show');
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resultBlockHtml(prefix, title, footer) {
    return `
    <div class="card result-section" id="${prefix}section">
        <div class="card-label">📊 ${title || '結果'}</div>
        <div class="score-wrap">
            <div class="score-ring">
                <svg width="200" height="200" viewBox="0 0 200 200">
                    <circle cx="100" cy="100" r="90" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
                    <circle cx="100" cy="100" r="90" fill="none" stroke="#ffd166" stroke-width="12" stroke-linecap="round"
                        stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" id="${prefix}arc"
                        style="transition:stroke-dashoffset 1.6s ease-out,stroke 1.2s;"/>
                </svg>
                <div class="score-inner"><div class="score-num" id="${prefix}num">0%</div><div class="score-sub">Accuracy</div></div>
            </div>
            <div class="score-msg" id="${prefix}msg"></div>
            <div class="stats" id="${prefix}stats"></div>
        </div>
        <div class="cmp-label">Original Text</div>
        <div class="cmp-box" id="${prefix}orig"></div>
        <div class="cmp-label">Your Speech</div>
        <div class="cmp-box" id="${prefix}spoken"></div>
        <p class="hint">WPM・Volume・Fluency はマイク入力からの自動推定（目安）です。スピーチの目安は 100〜170 WPM。</p>
        ${footer || ''}
    </div>`;
}

// ---------- Per-sentence practice list (Play / Record & Score) ----------
// items: [{en, ja, label}] ; getRate: () => number
function buildItemList(container, items, getRate, prefix) {
    const recs = {};
    container.innerHTML = items.map((s, i) => `
        <div class="item" id="${prefix}item-${i}">
            ${s.label ? `<div class="item-num">${s.label}</div>` : ''}
            <div class="en ${prefix}en">${s.html || escapeHtml(s.en)}</div>
            ${s.ja ? `<div class="ja ${prefix}ja">${escapeHtml(s.ja)}</div>` : ''}
            <div class="item-actions">
                <button class="mini-btn play" data-i="${i}" data-act="play">▶ Play</button>
                <button class="mini-btn record" data-i="${i}" data-act="rec">● Record &amp; Score</button>
            </div>
            <div class="mini-result" id="${prefix}res-${i}"></div>
        </div>`).join('');
    container.addEventListener('click', async e => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const i = +b.dataset.i;
        if (b.dataset.act === 'play') { speakText(items[i].en, getRate()); return; }
        if (recs[i]) {
            const r = recs[i]; delete recs[i];
            b.classList.remove('recording'); b.innerHTML = '● Record &amp; Score';
            document.getElementById(prefix + 'item-' + i).classList.remove('active');
            const out = await r.stop();
            showMini(prefix, i, items[i].en, out.text);
            return;
        }
        if (!hasRecognition()) { alert('このブラウザは音声認識に対応していません。Chrome / Edge をご利用ください。'); return; }
        speechSynthesis.cancel();
        const r = new Recorder();
        try { await r.start(); } catch (_) { alert('マイクへのアクセスを許可してください。'); return; }
        recs[i] = r;
        b.classList.add('recording'); b.innerHTML = '■ Stop &amp; Score';
        document.getElementById(prefix + 'item-' + i).classList.add('active');
        document.getElementById(prefix + 'res-' + i).classList.remove('show');
    });
}

function showMini(prefix, i, en, spoken) {
    const el = document.getElementById(prefix + 'res-' + i);
    el.classList.add('show');
    if (!spoken) { el.innerHTML = '<span style="color:#ff9800">音声が検出されませんでした。マイクの許可を確認してください。</span>'; return; }
    const c = compare(en, spoken);
    const words = c.origRes.map(x => `<span class="${x.t === 'ok' ? 'm' : 'x'}">${escapeHtml(x.word)}</span>`).join(' ');
    el.innerHTML = `<span class="mini-score" style="color:${gradeColor(c.pct)}">${c.pct}%</span>${gradeMsg(c.pct)}
        <div>${words}</div><div class="heard">あなたの発話: ${escapeHtml(spoken)}</div>`;
}

// Pill group helper: buttons with data-v; calls cb(value)
function pillGroup(id, cb) {
    const g = document.getElementById(id);
    g.addEventListener('click', e => {
        const b = e.target.closest('.pill');
        if (!b) return;
        g.querySelectorAll('.pill').forEach(x => x.classList.toggle('on', x === b));
        cb(b.dataset.v);
    });
}

function showWarnIfNoSR() {
    if (!hasRecognition()) {
        const el = document.getElementById('warn');
        if (el) { el.textContent = '⚠️ このブラウザは音声認識に対応していません。Chrome / Edge をご利用ください。'; el.style.display = 'block'; }
    }
}

// Safe localStorage
const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
};

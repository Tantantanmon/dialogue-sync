/**
 * Dialogue Sync
 * PART 1(<english_output>)의 "English. (한국어.)" 대사를
 * PART 2(<trans_korean>)의 한국어 전용 대사에 붙여준다.
 *
 * - 수동 실행 (✂ 버튼 클릭 시에만)
 * - 이미 영어가 붙어있는 대사는 건너뜀 (멱등)
 * - 매칭 실패한 대사는 건드리지 않음
 */

(function () {
    'use strict';

    const BUTTON_CLASS = 'dialogue_sync_button';

    /* ---------------- 블록 추출 ---------------- */

    const RE_ENG_BLOCK = /<english_output>([\s\S]*?)<\/english_output>/i;
    // 유저 템플릿이 <small><trans_korean> ... </small></trans_korean> 로
    // 태그가 어긋나 있으므로, 여는/닫는 지점을 각각 느슨하게 잡는다.
    const RE_KOR_OPEN = /<trans_korean>/i;
    const RE_KOR_CLOSE = /<\/trans_korean>/i;

    function extractEnglishBlock(text) {
        const m = text.match(RE_ENG_BLOCK);
        return m ? m[1] : null;
    }

    /**
     * PART 2 본문의 시작/끝 인덱스를 찾는다.
     * 닫는 태그 앞에 </small> 이 붙어있으면 그것도 본문에서 제외.
     */
    function locateKoreanBlock(text) {
        const open = text.match(RE_KOR_OPEN);
        const close = text.match(RE_KOR_CLOSE);
        if (!open || !close) return null;

        let start = open.index + open[0].length;
        let end = close.index;
        if (end <= start) return null;

        // 닫는 태그 직전의 </small> 은 본문이 아니므로 뒤로 밀어낸다.
        const tail = text.slice(start, end);
        const trailingSmall = tail.match(/<\/small>\s*$/i);
        if (trailingSmall) {
            end = start + trailingSmall.index;
        }

        return { start, end, body: text.slice(start, end) };
    }

    /* ---------------- 대사 파싱 ---------------- */

    // 큰따옴표(", “ ”) 로 감싸인 구간
    const RE_QUOTED = /[""]([^""]+)[""]/g;

    // "영어 (한국어)" 형태인지 판정: 끝이 괄호로 닫히고, 괄호 안에 한글이 있고,
    // 괄호 앞에 라틴 문자가 있는 경우
    function splitPair(inner) {
        const m = inner.match(/^([\s\S]*?)\s*[(（]([\s\S]*?)[)）]\s*$/);
        if (!m) return null;
        const eng = m[1].trim();
        const kor = m[2].trim();
        if (!eng || !kor) return null;
        if (!/[A-Za-z]/.test(eng)) return null;
        if (!/[가-힣]/.test(kor)) return null;
        return { eng, kor };
    }

    function hasHangul(s) {
        return /[가-힣]/.test(s);
    }

    function hasLatin(s) {
        return /[A-Za-z]/.test(s);
    }

    /* ---------------- 유사도 ---------------- */

    function normalize(s) {
        return s
            .replace(/\s+/g, '')
            .replace(/[.,!?…·~\-—"'"'「」『』()（）]/g, '')
            .toLowerCase();
    }

    // 바이그램 기반 Dice 계수
    function similarity(a, b) {
        const x = normalize(a);
        const y = normalize(b);
        if (!x || !y) return 0;
        if (x === y) return 1;
        if (x.length < 2 || y.length < 2) {
            return x === y ? 1 : 0;
        }

        const grams = new Map();
        for (let i = 0; i < x.length - 1; i++) {
            const g = x.slice(i, i + 2);
            grams.set(g, (grams.get(g) || 0) + 1);
        }

        let hits = 0;
        for (let i = 0; i < y.length - 1; i++) {
            const g = y.slice(i, i + 2);
            const c = grams.get(g) || 0;
            if (c > 0) {
                grams.set(g, c - 1);
                hits++;
            }
        }

        return (2 * hits) / (x.length - 1 + y.length - 1);
    }

    const SIM_THRESHOLD = 0.55;

    /* ---------------- 핵심 변환 ---------------- */

    function syncDialogue(fullText) {
        const engBlock = extractEnglishBlock(fullText);
        if (!engBlock) return null;

        const korLoc = locateKoreanBlock(fullText);
        if (!korLoc) return null;

        // PART 1에서 쌍 수집
        const pairs = [];
        let m;
        RE_QUOTED.lastIndex = 0;
        while ((m = RE_QUOTED.exec(engBlock)) !== null) {
            const pair = splitPair(m[1]);
            if (pair) pairs.push(pair);
        }
        if (pairs.length === 0) return null;

        // PART 2의 따옴표 구간 수집
        const korBody = korLoc.body;
        const targets = [];
        RE_QUOTED.lastIndex = 0;
        while ((m = RE_QUOTED.exec(korBody)) !== null) {
            targets.push({
                start: m.index,
                end: m.index + m[0].length,
                open: m[0][0],
                close: m[0][m[0].length - 1],
                inner: m[1],
            });
        }
        if (targets.length === 0) return null;

        // 이미 정상인 것 / 손봐야 하는 것 분류
        const pending = [];
        for (const t of targets) {
            if (splitPair(t.inner)) {
                t.skip = true; // 이미 영어 + 괄호 한국어
                continue;
            }
            if (!hasHangul(t.inner)) {
                t.skip = true; // 한글이 없으면 대상 아님
                continue;
            }
            if (hasLatin(t.inner) && /[(（]/.test(t.inner)) {
                t.skip = true; // 애매한 형태는 건드리지 않음
                continue;
            }
            pending.push(t);
        }
        if (pending.length === 0) return null;

        const used = new Set();

        // 1차: 유사도 매칭
        for (const t of pending) {
            let bestIdx = -1;
            let bestScore = 0;
            for (let i = 0; i < pairs.length; i++) {
                if (used.has(i)) continue;
                const score = similarity(t.inner, pairs[i].kor);
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0 && bestScore >= SIM_THRESHOLD) {
                t.match = pairs[bestIdx];
                used.add(bestIdx);
            }
        }

        // 2차: 개수가 정확히 일치하면 순서대로 채운다
        const unmatched = pending.filter((t) => !t.match);
        if (unmatched.length > 0 && targets.length === pairs.length) {
            for (const t of unmatched) {
                const idx = targets.indexOf(t);
                if (idx >= 0 && idx < pairs.length && !used.has(idx)) {
                    t.match = pairs[idx];
                    used.add(idx);
                }
            }
        }

        const applied = pending.filter((t) => t.match);
        if (applied.length === 0) return null;

        // 뒤에서부터 치환 (인덱스 보존)
        let newBody = korBody;
        for (let i = targets.length - 1; i >= 0; i--) {
            const t = targets[i];
            if (!t.match) continue;
            const replacement =
                t.open + t.match.eng + ' (' + t.inner.trim() + ')' + t.close;
            newBody = newBody.slice(0, t.start) + replacement + newBody.slice(t.end);
        }

        return (
            fullText.slice(0, korLoc.start) + newBody + fullText.slice(korLoc.end)
        );
    }

    /* ---------------- SillyTavern 연동 ---------------- */

    function getContext() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
        return null;
    }

    async function onButtonClick(event) {
        event.stopPropagation();

        const ctx = getContext();
        if (!ctx) return;

        const $mes = $(event.currentTarget).closest('.mes');
        const mesId = Number($mes.attr('mesid'));
        if (Number.isNaN(mesId)) return;

        const message = ctx.chat[mesId];
        if (!message || typeof message.mes !== 'string') return;

        const result = syncDialogue(message.mes);
        if (!result || result === message.mes) return;

        message.mes = result;

        // 현재 보이는 swipe도 함께 갱신
        if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
            message.swipes[message.swipe_id] = result;
        }

        ctx.updateMessageBlock(mesId, message);
        await ctx.saveChat();
    }

    function addButton($mes) {
        const $container = $mes.find('.mes_buttons');
        if ($container.length === 0) return;
        if ($container.find('.' + BUTTON_CLASS).length > 0) return;

        const $btn = $(
            '<div class="mes_button ' +
                BUTTON_CLASS +
                ' fa-solid fa-scissors interactable" ' +
                'title="영어 대사 붙이기" tabindex="0"></div>'
        );
        $btn.on('click', onButtonClick);
        $container.prepend($btn);
    }

    function addButtonsToAll() {
        $('#chat .mes').each(function () {
            addButton($(this));
        });
    }

    function init() {
        const ctx = getContext();
        if (!ctx) {
            setTimeout(init, 500);
            return;
        }

        const { eventSource, event_types } = ctx;

        const renderEvents = [
            event_types.CHARACTER_MESSAGE_RENDERED,
            event_types.USER_MESSAGE_RENDERED,
            event_types.MESSAGE_SWIPED,
            event_types.MESSAGE_UPDATED,
        ].filter(Boolean);

        for (const ev of renderEvents) {
            eventSource.on(ev, () => {
                setTimeout(addButtonsToAll, 0);
            });
        }

        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(addButtonsToAll, 100);
            });
        }

        addButtonsToAll();
    }

    jQuery(() => {
        init();
    });
})();

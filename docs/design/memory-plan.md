# План внедрения продвинутой памяти и «живого мира» для AI-RPG

> Цель: NPC помнят игрока и события спустя часы/дни, решения имеют последствия, а время ответа остаётся быстрым (без «3 минуты на один ход»).

---

## 0) Важные корректировки (добавлено)

Перед деталями ниже фиксируем ключевые принципы, чтобы не потерять события и причинность:

1) **Event-sourcing lite:** события пишутся append-only в канон (`events`), а `entity_state/relations/quest_state` считаются проекциями.
2) **Стабильные сущности:** все ссылки идут через `entity_id`; имена и алиасы проходят через слой `entity resolution` (дедупликация).
3) **Надёжная запись в 2 фазы:** сначала транзакционная запись фактов в Postgres, затем асинхронная генерация embeddings и upsert в векторное хранилище.
4) **Гибридный retrieval:** vector + keyword + metadata filters + recency/importance/mentions (а не только cosine topK).
5) **GraphRAG не как фундамент:** применять позже для глобального lore/расследований, а не как основной механизм каждого хода.

---

## 0.1) Статус внедрения (2026-02-17)

- [x] Подготовлена миграция `backend/migrations/001_world_memory_v1.sql`:
  - `events` (append-only), `entities`, `entity_state`, `relations`, `quest_state`
  - `memory_items`, `embedding_jobs` (outbox)
  - индексы + RPC `search_memory_context_hybrid`
- [x] Интегрирован backend world-memory сервис (`backend/supabaseWorldService.js`):
  - запись `turns/events/memory_items`
  - upsert сущностей/состояний/отношений
  - embedding outbox + retry
  - retrieval памяти для GM через RPC/fallback
- [x] Подключение в runtime:
  - `backend/index.js` (init, recordTurn, clearSession, stats)
  - `backend/geminiService.js` (приоритет retrieval из world memory)
- [x] Применение миграции в Supabase через MCP
- [x] Smoke-проверка в БД:
  - read-only SQL OK (`current_database/current_user`)
  - таблицы и RPC созданы
  - `search_memory_context_hybrid` возвращает результат на тестовых данных
- [x] Полный E2E-прогон из приложения (реальный ход игры -> запись turns/events/memory_items):
  - `/api/action` выполнен успешно
  - в БД созданы записи `turns/events/memory_items/entities/embedding_jobs`
  - тестовая сессия удалена после проверки
- [x] Pinecone сделан опциональным через env-флаг:
  - добавлен `PINECONE_ENABLED=true/false`
  - при `PINECONE_ENABLED=false` Pinecone init полностью пропускается
- [x] Реализован сквозной `mentions`-контракт (UI -> API -> runtime):
  - `@mentions` в UI с автокомплитом
  - `mentions[]` в `POST /api/action`
  - гарантированная вставка `mentions` в GM-контекст: dossier + связанные memories
  - базовый entity-resolution по `display_name/aliases` + merge aliases
- [x] Добавлены мини-профили NPC в Postgres (`entity_state.state`):
  - `persona` (эвристика по статусу + репликам NPC)
  - `goals` (из активных quest objectives с упоминанием NPC)
  - `last_dialogue` + существующие `relation_to_player`/`last_seen_*`
- [x] Внедрён runtime `Context Builder` (`backend/contextBuilder.js`):
  - режимы хода (`narration/combat/downtime/state_update`)
  - секции с лимитами (mentions, dossiers, deterministic facts, consequences, ranked memories)
  - fusion scoring (importance/recency/mentions/quest-priority) + параллельный retrieval
  - cache статических секций (dossiers/deterministic) + артефакты retrieval
- [x] Добавлены наблюдаемость и последствия:
  - запись `turn_artifacts` (новая миграция `backend/migrations/002_turn_artifacts_v1.sql`)
  - шаблоны отложенных последствий (`debt_due/revenge/rumor_spread`) через `events/event_edges`
  - выдача “due consequences” в контекст ГМа на соответствующих ходах
- [x] Миграция `002_turn_artifacts_v1.sql` применена в Supabase (таблица `public.turn_artifacts` создана)
- [x] Реализован State Updater v1 (`backend/migrations/003_state_updater_v1.sql` + runtime интеграция):
  - extractor `backend/statePatchExtractor.js` формирует JSON patches (`state/relations/quests/events`)
  - транзакционный RPC `apply_state_patches_v1` применяет патчи атомарно
  - валидация запрета impossible-transition (`dead -> alive`) без явной причины
- [x] Реализованы world-tick/encounter триггеры (last_seen + probabilities):
  - `encounter_hint` генерируется в world tick по детерминированной вероятности
  - триггеры попадают в due-consequences retrieval и подмешиваются в GM-контекст
- [x] Миграция `003_state_updater_v1.sql` применена в Supabase (RPC `apply_state_patches_v1` доступен)
- [x] Реализован Stage 6 `NPC Reflection` в runtime (`backend/supabaseWorldService.js` + контекст):
  - периодическая рефлексия NPC раз в `NPC_REFLECTION_EVERY_N_EVENTS` событий (по умолчанию `4`)
  - выводы сохраняются в `entity_state.state.reflection` и закрепляются как `pinned` `memory_items` (`memory_type='npc_reflection'`)
  - добавлены `goal_system` + `behavior` (tone/risk/generosity/trust) и прокинуты в контекст ГМа
- [x] Реализован Stage 8 `Eval Gate`:
  - `tests/eval-memory-gate.mjs`: regression-сценарии + SLO (`memory_recall@k`, `p95 latency`, `consistency_violations`, `empty_retrieval_rate`)
  - `tests/release-gate.mjs`: автоматический pre-release прогон `smoke + eval`
  - npm-скрипты: `test:eval-memory-gate`, `test:release-gate`
- [x] Реализован Stage 7 `GraphRAG v1` (safe rollout):
  - миграция `backend/migrations/004_graph_rag_v1.sql` (`graph_nodes/graph_edges/graph_summaries/graph_jobs/graph_checkpoints`)
  - миграция `004_graph_rag_v1` применена в Supabase (таблицы GraphRAG доступны)
  - `complex-only` роутинг + runtime timeout/fallback (`GRAPH_RAG_TIMEOUT_MS`, default `500ms`)
  - `on-demand + cache` summary lane и фоновые graph-jobs после каждого хода
  - observability: `metadata.graph_rag` в `turn_artifacts` + `debug.graphRagState` в `/api/memory-stats`

---

## 0) Концепт: что строим и зачем

### Суть
Мы строим **движок памяти**, а не «ещё один промпт».

1) **Каноничное состояние мира (Truth)** — хранится в **Postgres/Supabase**  
   Это то, что *должно быть истинным*: квесты, флаги, отношения, позиции, инвентари, статусы, причинность.

2) **Долгая память (Flavor/Recall)** — хранится в **Pinecone/pgvector** как **атомарные воспоминания**  
   Это то, что делает мир живым: короткие факты, долги, встречи, слухи, обещания.

3) Между игроком и LLM стоит **Context Builder**  
   Он решает, что именно показать модели на этот ход: *только релевантное* + *гарантии через mentions*.

4) После каждого хода работают **Memory Writer + State Updater**  
   Они фиксируют последствия, обновляют мир и пишут воспоминания так, чтобы важное не терялось.

### Почему именно так
- LLM без внешней памяти не имеет состояния между запросами: всё «помнит» только то, что в текущем контексте.
- Векторная БД идеальна для **семантического извлечения** деталей из прошлого.
- Postgres нужен для **логической целостности** и детерминированных правил мира.

---

## 1) Что нужно внедрить (модули)

### A) Entity Registry (реестр сущностей)
Единый каталог всего, что может появиться в игре:

- `entity_id` (стабильный ID)
- `entity_type`: `npc | location | item | faction | player | quest | event_tag`
- `name`, `aliases[]`
- `description_short`
- (для NPC) `persona` / «лист персонажа»: характер, стиль речи, ценности, страхи, цели

**Зачем:** память и состояние должны ссылаться не на “Боб в тексте”, а на `entity_id`.

Дополнительно:
- `canonical_name` + `aliases[]`
- `entity_resolution_confidence`
- правила слияния дублей (merge policy), чтобы `Боб`, `Robert`, `старик у колодца` не распадались на разные сущности.

---

### B) Каноничное состояние мира в Postgres/Supabase
Минимальный набор таблиц (расширяем по мере роста):

1) `game_sessions` — сейв/кампания  
2) `turns` — лог ходов (ввод игрока, ответ ГМа, служебные данные)  
3) `entities` — реестр сущностей  
4) `entity_state` — динамика NPC/мира (муд, цели, last_seen_location, флаги, здоровье…)  
5) `relations` — граф-lite: `(from_entity, relation_type, to_entity, weight, updated_at)`  
6) `events` — атомарные события: `event_id, type, time, location_id, actors[], summary, importance`  
7) `event_edges` — причинность: `cause_event_id -> effect_event_id`  
8) `quest_state` — активные квесты, стадии, условия/триггеры
9) `embedding_jobs` (outbox) — очередь на генерацию embeddings/reindex
10) `turn_artifacts` — необязательный техлог (context id, retrieval hit list, latency)

**Зачем:** последствия становятся вычисляемыми и проверяемыми, а не “как LLM вспомнит”.

Правило:
- `events` — append-only (не переписываем историю).
- `entity_state/relations/quest_state` — производные, допускают перерасчёт и восстановление из `events`.

---

### C) Long-term memory в Pinecone (атомарные записи)
Каждый MemoryItem — **один** факт/наблюдение/договор/изменение отношений.

**Рекомендуемый формат MemoryItem (поля):**
- `memory_id`
- `session_id`
- `text` (1–2 предложения)
- `entity_ids[]` (кто связан)
- `location_id?`
- `turn_id`, `timestamp`
- `type`: `interaction | promise | help | betrayal | rumor | combat | discovery | quest | relationship_change ...`
- `importance` (0–1 или 1–10)
- `pinned` (bool) — “не забывать никогда”
- `source_event_id` (ссылка на каноничное событие)
- `valid_from`, `valid_to` (для временной логики/устаревших фактов)
- `embedding` (в Pinecone)

**Зачем:**  
- атомарность = детали не размываются суммаризацией  
- метаданные = фильтрация и быстрый retrieval  
- pinned = сюжетные якоря / базовые факты

Важно:
- запись `memory_items` в SQL и запись в vector index не должны быть одной синхронной точкой отказа;
- embeddings пишутся асинхронно через `embedding_jobs`, чтобы ничего не терялось при сбоях API/сети.

---

### D) Mentions (@) — обязательная фича
**Frontend:**
- автокомплит по сущностям: `@Bob`, `@Мегатонна`, `@БратствоСтали`
- в payload на бэкенд: `mentions: [entity_id, ...]`

**Backend (контракт):**
- всё, что в mentions, **гарантированно** попадает в контекст:
  - досье сущности
  - ключевые связи
  - топ воспоминаний (важные + релевантные)

**Зачем:** ручной рычаг “подними это из памяти” и лучший инструмент для дебага.

---

### E) Context Builder — ядро системы (скорость + консистентность)
Собирает **ровно тот контекст**, который нужен модели на этот ход.

**Вход:** текущий turn, локация, party, mentions, последние N сообщений  
**Выход:** структурированный контекст/промпт для ГМа

**Алгоритм сборки:**
1) Определить режим: `narration | state_update | combat | downtime`
2) Сущности-кандидаты:
   - party NPC
   - nearby NPC (по локации/координатам)
   - mentions (обязательно)
   - сущности, найденные в тексте (alias match / NER)
3) Из Postgres:
   - досье NPC (роль, характер, цели, отношение, долги/обещания, last_seen)
   - состояние локации, активные квесты, флаги
   - связи `relations` (друзья/враги/фракции)
4) Retrieval:
   - lane A (deterministic SQL): активные квесты, отношения, долги, last_seen, критичные флаги
   - lane B (vector): semantic topK по `memory_items` с фильтрами `session_id`, `entity_ids`, `location_id`
   - lane C (keyword/fts): точные совпадения имён, предметов, долгов, квестовых терминов
5) Fusion/ранжирование (RRF или эквивалент): `similarity + importance + recency + bonus_mentions + quest_priority`
6) Temporal слой:
   - “последняя встреча с NPC”
   - “последний долг/обещание”
   - “события в окне T ходов перед текущей локацией”
6) Упаковка в prompt секциями и лимитами токенов

**Зачем:** ты перестаёшь “пихать весь мир в промпт” — и ответы становятся быстрыми.

---

### F) Memory Writer + State Updater — после каждого хода
После ответа ГМа:
- извлечь новые факты
- обновить Postgres-канон
- записать Pinecone-память

**Лучший подход:** требовать от вспомогательной модели **структурированный JSON**:
- новые/обновлённые сущности
- события (`events`)
- патчи состояния (`entity_state`)
- изменения отношений (`relations`)
- список `memory_items` для Pinecone

**Зачем:** LLM не “сам всё помнит” — он сдаёт отчёт, а ты применяешь изменения транзакционно.

Критично:
- сначала транзакция в Postgres (`events`, `relations`, `entity_state`, `memory_items_sql`, `embedding_jobs`);
- затем worker обрабатывает `embedding_jobs` и пишет в vector store;
- при неуспехе worker делает retry (backoff), данные не теряются.

---

### G) Consequence Engine — последствия + встречи через время/карту
Чтобы работало: “дал воду → встретил через 10 часов → он вспомнил”.

Компоненты:
- `events` и `relations` фиксируют факт помощи и отношение NPC
- “мир тикает” (`world tick`): NPC перемещаются по карте/графу локаций
- при входе игрока в локацию:
  - выбираются потенциальные встречаемые сущности (по last_seen/планам/вероятностям)
  - в контекст добавляются причины реакции (relation + события + memories)

**Зачем:** последствия становятся механикой, а не красивыми словами.

---

### H) GraphRAG (опционально, поздний этап)
Использовать для:
- глобальных сюжетных линий фракций,
- “расследовательских” дуг,
- суммаризации длинной истории кампании.

Не использовать как базовый runtime на каждый ход, пока не стабилизированы:
- канон событий,
- relations,
- hybrid retrieval,
- latency-бюджет.

---

### I) Eval & Observability (обязательно)
Чтобы система не деградировала незаметно:

- Сценарные тесты (golden set):
  - “дал воду в деревне -> случайная встреча через N ходов -> узнавание”
  - “обещал долг -> NPC напоминает в другой локации”
  - “предал фракцию -> отложенные санкции”
- Метрики:
  - `memory_recall@k` по сценарию
  - `consistency_violations` (канон против нарратива)
  - `p95_turn_latency`
  - доля ходов с пустым/нерелевантным retrieval
- Техлоги:
  - какие memories/relations попали в контекст
  - почему были отранжированы (score breakdown)

---

## 2) Дорожная карта внедрения (как путь от MVP к “ACE-уровню”)

### Этап 1 — «Ничего не теряем»
**Цель:** начать сохранять историю и факты правильно.

- [x] Подключить Postgres/Supabase
- [x] Сохранять `turns` (лог) + мета (локация, party, retrieved ids)
- [x] Ввести `events` append-only как канон
- [x] Ввести `entities` и стабильные `entity_id` + alias map
- [x] Писать атомарные `MemoryItem` в SQL + `embedding_jobs` (outbox)
- [x] Поднять worker для embeddings + upsert в Pinecone/pgvector
- [x] Ввести `importance` и `pinned` (пока эвристикой)

**Результат:** появляется надёжный “архив”, из которого можно извлекать память.

---

### Этап 2 — Mentions + NPC Dossier
**Цель:** управляемая память и стабильность для игрока/ГМа.

- [x] UI mentions `@` + автокомплит
- [x] API принимает `mentions[]`
- [x] Backend гарантирует: dossier + ключевые memories по mentions
- [x] Мини-профили NPC в Postgres (`persona`, цели, отношение, last_seen)
- [x] Entity resolution (dedupe + merge policy)

**Результат:** поднятие старых NPC без боли и без “забывания”.

---

### Этап 3 — Context Builder (скорость + качество)
**Цель:** всегда давать модели релевантное и только релевантное.

- [x] Пайплайн сборки контекста (секции + лимиты)
- [x] Гибридный retrieval: vector + keyword + metadata filters
- [x] Fusion (RRF) + temporal features в скоринге
- [x] Кэширование досье/локаций
- [x] Параллельные запросы: Postgres + Pinecone

**Результат:** быстрые ответы, меньше галлюцинаций.

---

### Этап 4 — State Updater (канон отделён от нарратива)
**Цель:** мир не переписывается каждым ответом LLM.

- [x] Extractor → JSON-патчи состояния/событий/отношений
- [x] Транзакционное применение патчей
- [x] Валидация изменений (запрет невозможного без причины)
- [x] Правило “events неизменяемы, проекции пересчитываемы”

**Результат:** консистентный мир: “умер — значит умер”, пока не воскресили событием.

---

### Этап 5 — Relations + Consequences (настоящие последствия)
**Цель:** «дал воду → всплыло позже» становится системой, а не случайностью.

- [x] Таблица `relations` и обновление из extractor
- [x] Таблицы `events` + `event_edges` (причины/следствия)
- [x] Простой world tick (перемещения, изменение состояния локаций)
- [x] Встречи/триггеры на основе last_seen + вероятностей
- [x] В контекст добавляются причины реакции NPC
- [x] Ввести шаблоны отложенных последствий (debt_due, revenge, rumor_spread)

**Результат:** причинность, повторные встречи, “долги”, слухи.

---

### Этап 6 — «Живые NPC» (рефлексия + цели)
**Цель:** NPC не только помнят, но и меняются.

- [x] Периодическая рефлексия NPC (раз в N событий) → выводы уровня “я доверяю игроку”
- [x] Хранить выводы как pinned memories + обновлять `entity_state`
- [x] Система целей (`goals`) и простые правила поведения (тон/риск/щедрость)

**Результат:** ощущение личности и эволюции персонажей.

---

### Этап 7 — GraphRAG (опционально)
**Цель:** улучшить глобальные арки и сложные запросы к истории кампании.

- [x] Построить knowledge graph из `events/entities/relations`
- [x] Ввести summarization-слои для длинных кампаний
- [x] Включать GraphRAG только для сложных запросов, не для каждого хода
- [x] Зафиксировать runtime-инвариант Stage 7+: `SIMPLE_MEMORY_ENABLED=false` в production, чтобы legacy simple-memory слой не подмешивал шум в hybrid/graph retrieval

**Результат:** качественное “макро-понимание” мира без деградации latency.

Подробный план реализации: [PLAN for stage 7.md](PLAN for stage 7.md)


---

### Этап 8 — Eval Gate
**Цель:** выпускать улучшения памяти только с проверяемым приростом качества.

- [x] Набор regression-сценариев на память/последствия
- [x] Автоматический прогон перед релизом
- [x] SLO: p95 latency + recall/consistency thresholds

**Результат:** развитие системы без скрытой регрессии.

---

### Этап 9 — Canonical Integrity (анти-дубли и инварианты мира)
**Цель:** устранить противоречия канона (например, `Goodsprings` vs `Goodsprings Ruins`) и сделать состояния мира строгими.

- [ ] Ввести canonical entity identity:
  - один `canonical_entity_id` на реальный объект мира
  - алиасы/варианты названий (`Goodsprings`, `Goodsprings Ruins`) маппятся на канон
- [ ] Добавить lifecycle-инварианты для сущностей (в первую очередь локаций):
  - `destroyed -> intact` запрещён без явного события `rebuild/restore`
  - состояние “разрушен” хранится как атрибут каноничной сущности, а не как отдельный дубликат-entity
- [ ] Усилить извлечение target-сущностей из player action:
  - автоподхват локации из текста (даже без `@mention`)
  - гарантированная подмешка каноничного статуса target-локации в deterministic context
- [ ] Добавить merge/repair job для уже появившихся дублей:
  - перенос `relations/events/state` на каноничную сущность
  - marking legacy aliases и безопасный дедуп
- [ ] Добавить detector противоречий в eval:
  - тесты на mutually-exclusive состояния одной каноничной сущности
  - сценарий “локация разрушена -> через N ходов не может быть целой без restore-event”

**Результат:** канон не “расщепляется” на дубли, а последствия сохраняют причинность на длинной дистанции.

---

## 3) Критерии готовности (тестируемые)
- [ ] NPC узнаёт игрока после долгого перерыва
- [ ] Действия игрока приводят к отложенным последствиям (через events/relations)
- [ ] Mentions всегда “вытягивают” нужное в контекст (железный контракт)
- [ ] Каноничное состояние мира консистентно и не “прыгает”
- [ ] Среднее время ответа не деградирует при росте истории (контекст ограничен, retrieval быстрый)
- [ ] Потеря фактов из-за сбоев embeddings/Pinecone = 0 (за счёт SQL+outbox)

---

## 4) Что внедрять в коде (короткий чек-лист)
- [x] Postgres schema: entities/turns/state/relations/events/event_edges/quest_state
- [x] Pinecone memory schema: atomic MemoryItem + метаданные + pinned
- [x] Outbox/worker для embeddings и retries
- [x] Mentions: UI + backend контракт “гарантировать в контексте”
- [x] Context Builder: hybrid retrieval + fusion + temporal features + секции + лимиты
- [x] Extractor (структурный JSON) + State Updater (транзакции + валидация)
- [x] Consequence Engine: world ticks + встречи + триггеры
- [x] Eval harness + метрики качества памяти

---

## 5) Рекомендуемые “лимиты по умолчанию” (чтобы было быстро)
- Последние сообщения диалога: `6–10`
- TopK memories per entity: `4–8` (плюс `1–3 pinned`)
- Кол-во сущностей в контексте: `party + mentions + nearby (cap 5–10)`
- Retrieval (Postgres+Vector+FTS параллельно): целиться в `<150ms`
- Extractor: отдельный быстрый проход, чтобы не тормозить основной ответ
- Контекст-бюджет: жёсткий cap по токенам на каждую секцию

---

## 6) Мини-схема потока (один ход)
1) Игрок → сообщение (+ mentions, локация, party)  
2) Context Builder → Postgres + Pinecone → промпт  
3) GM LLM → ответ  
4) Extractor → JSON (events/state/relations/memories)  
5) State Updater → Postgres transaction  
6) Memory Writer → SQL + outbox  
7) Embedding worker → Pinecone/pgvector upsert  

---

Если хочешь следующим шагом: добавлю в отдельный файл **DDL для Supabase** и **JSON-схему патчей** для extractor’а (чтобы можно было сразу кодить).

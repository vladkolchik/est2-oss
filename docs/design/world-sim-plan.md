> Мини-заметка о будущем расширении:
> Этот Stage 10 закладывает не точечную механику `wait`, а базовый слой `world simulator` поверх каноничных `events/entity_state/relations`. На этой архитектуре дальше можно без переписывания ядра наращивать более тяжелые подсистемы:
> `World sim v1 -> Faction sim v1 -> Settlement sim v1 -> Economy sim v1 -> Full world sim`.
> Практически это означает, что после внедрения автономной симуляции NPC и offscreen-событий сюда можно будет последовательно добавить войны и цели фракций, жизнь поселений, ресурсы, торговлю, дефициты и уже затем связать все это в полную симуляцию мира. Критическая зависимость перед таким расширением: закрыть `Stage 9 Canonical Integrity`, чтобы экономика, поселения и фракции не опирались на дубли сущностей и противоречивые состояния канона.

# Stage 10 — Автономная симуляция мира без присутствия игрока

## Summary

Сейчас проект уже умеет хранить канон мира, отношения, отложенные последствия, `world_tick`, `encounter_hint`, NPC reflection и GraphRAG. Но весь этот мир двигается только внутри `recordTurn()`, то есть только когда игрок делает ход. Из-за этого мир не живет в отсутствие игрока, а лишь реагирует на его запросы.

Новая стадия должна добавить автономную симуляцию по модели `idle catch-up`: когда игрок возвращается после паузы, загружает сейв или явно делает `wait/sleep/pass time`, сервер досчитывает прошедшее мировое время пакетно, записывает каноничные offscreen-события в Supabase и подмешивает их в следующий ответ ГМа органически, без отдельного “мирового лога” в UI. В v1 симуляция безопасна для игрока: она меняет мир вокруг него, но не убивает и не калечит персонажа оффскрин.

## Public Interfaces / Types / Config

1. Добавить новую миграцию `backend/migrations/005_world_simulator_v1.sql`.

2. Ввести таблицу `public.world_runtime_state`:
   - `session_id uuid primary key references public.game_sessions(session_id) on delete cascade`
   - `world_time_minutes integer not null default 0`
   - `last_player_action_at timestamptz not null default now()`
   - `last_simulated_at timestamptz not null default now()`
   - `last_sync_reason text not null default 'init'`
   - `player_anchor_location_name text`
   - `player_anchor_coordinates jsonb not null default '{"x":0,"y":0}'::jsonb`
   - `idle_mode text not null default 'safe' check (idle_mode in ('safe','soft_risk','full_risk'))`
   - `updated_at timestamptz not null default now()`

3. Ввести таблицу `public.world_sim_runs`:
   - `run_id bigserial primary key`
   - `session_id uuid not null references public.game_sessions(session_id) on delete cascade`
   - `trigger_type text not null check (trigger_type in ('idle_catchup','explicit_wait'))`
   - `source_turn_id bigint references public.turns(turn_id) on delete set null`
   - `from_world_minute integer not null`
   - `to_world_minute integer not null`
   - `requested_minutes integer not null default 0`
   - `applied_steps integer not null default 0`
   - `generated_event_count integer not null default 0`
   - `generated_memory_count integer not null default 0`
   - `status text not null default 'completed' check (status in ('completed','skipped','failed'))`
   - `summary jsonb not null default '{}'::jsonb`
   - `created_at timestamptz not null default now()`
   - `unique (session_id, trigger_type, from_world_minute, to_world_minute)`

4. Не добавлять отдельный UI-log. Пользовательская подача остается `Organic only`.

5. Расширить контракт `POST /api/action` опциональным полем:
   - `worldControl?: { mode: 'auto' | 'wait'; requestedMinutes?: number }`
   - Значение по умолчанию: `{ mode: 'auto' }`
   - Старые клиенты продолжают работать без изменений.

6. Расширить `GET /api/memory-stats` секцией `debug.worldSimulatorState`:
   - `enabled`
   - `lastSimulatedAt`
   - `worldTimeMinutes`
   - `lastSyncReason`
   - `lastRunStatus`
   - `lastRunEvents`
   - `idleMode`

7. В `types.ts` закрепить:
   - `sessionId?: string` в `GameState`, потому что поле уже фактически живет в runtime
   - новый frontend-тип `SaveEnvelope`
   - новый backend/frontend-тип `WorldControl`

8. В локальном сохранении перейти с разрозненных ключей на единый логический envelope:
   - `gameState`
   - `storyHistory`
   - `sessionId`
   - `savedAt`
   - `audioConfig`

9. Новые env-переменные:
   - `WORLD_SIM_ENABLED=true`
   - `WORLD_IDLE_MIN_REAL_SECONDS=180`
   - `WORLD_IDLE_REAL_TO_GAME_MINUTES=10`
   - `WORLD_IDLE_MAX_CATCHUP_MINUTES=1440`
   - `WORLD_WAIT_MAX_MINUTES=4320`
   - `WORLD_SIM_STEP_MINUTES=60`
   - `WORLD_SIM_MAX_STEPS_PER_RUN=24`
   - `WORLD_SIM_MAX_EVENTS_PER_STEP=3`

## Implementation Plan

### 1. Новый backend-модуль симуляции

Создать `backend/worldSimulator.js` как отдельный модуль, а не раздувать `supabaseWorldService.js` дальше. Он должен инкапсулировать:

1. `ensureRuntimeState(sessionId, currentState)`
2. `computeIdleCatchupBudget(runtimeState, now)`
3. `computeExplicitWaitBudget(worldControl, playerAction)`
4. `runSimulation(sessionId, options)`
5. `projectAuthoritativeScene(sessionId, currentState)`
6. `collectWorldSignalsForPrompt(sessionId, currentTurnNo, locationName, mentionEntityIds)`

`supabaseWorldService.js` остается источником доступа к канону, но не оркестратором симуляции.

### 2. Источник времени и правила catch-up

1. Для обычного хода:
   - до вызова `getNextGameState()` сервер читает `world_runtime_state`
   - считает `elapsedRealSeconds = now - last_simulated_at`
   - если `elapsedRealSeconds < WORLD_IDLE_MIN_REAL_SECONDS`, симуляция пропускается
   - иначе real-time конвертируется в game-time по формуле `elapsedRealMinutes * WORLD_IDLE_REAL_TO_GAME_MINUTES`
   - результат режется по `WORLD_IDLE_MAX_CATCHUP_MINUTES`

2. Для `worldControl.mode='wait'`:
   - `requestedMinutes` обязателен
   - значение режется по `WORLD_WAIT_MAX_MINUTES`
   - этот же engine используется без отдельной ветки логики

3. V1 не запускает постоянный фоновый worker. Весь мир досчитывается:
   - в начале `/api/action`
   - при явном `wait/sleep/pass time`
   - опционально на загрузке сейва в будущем, но не в первой поставке

### 3. Слои канона, которые двигает симуляция

Каждый simulation step делает только детерминированные и безопасные изменения:

1. Обновляет `world_runtime_state.world_time_minutes` и `last_simulated_at`.

2. Для NPC в `entity_state.state` поддерживает поддерево `world`:
   - `home_location_name`
   - `current_location_name`
   - `current_coordinates`
   - `routine`
   - `availability`
   - `last_simulated_world_minute`

3. Для location entity в `entity_state.state` поддерживает поддерево `world`:
   - `condition`
   - `recent_incidents`
   - `rumor_pressure`
   - `last_world_change_minute`

4. Создает append-only `events` типов:
   - `world_idle_tick`
   - `npc_travel`
   - `npc_activity`
   - `rumor_spread`
   - `encounter_hint`
   - уже существующие `debt_due` и `revenge` продолжают использоваться

5. При значимых offscreen-событиях создает `memory_items`:
   - только для важных изменений
   - с `memory_type='world_sim'`
   - с `importance` по той же шкале 0..1
   - с `source_event_id` на событие симуляции

6. Relations и quest consequences меняются только если шаг породил каноничную причину:
   - долг просрочился
   - месть эскалировалась
   - слух дошел до нужной локации
   - NPC переместился в локацию игрока и стал кандидатом на встречу

### 4. Правила симуляции v1

1. Scope фиксируем как `NPC + encounters`, без экономики и без глубокой симуляции поселений.

2. Каждый час world-time:
   - берется ограниченный набор активных NPC с известным `last_seen_location` или `home_location_name`
   - для каждого NPC детерминированно выбирается одно действие: `stay`, `travel`, `pursue_goal`, `spread_rumor`

3. Travel-модель:
   - uses only known world nodes from `discoveredLocations`, `location` entities and stored `home_location_name`
   - без pathfinding
   - NPC перемещается между известными локациями и обновляет `state.world.current_location_name`

4. Encounter-модель:
   - если NPC по симуляции оказывается в локации игрока или рядом с ней, создается `encounter_hint`
   - hint не телепортирует NPC в текущий клиентский `npcs[]` напрямую
   - hint идет в контекст и в канон, а ГМ уже подает это как “следы”, “слухи”, “кто-то зашел в деревню”, “на площади видели знакомого”

5. Rumor-модель:
   - важные события из `events` высокой важности могут переизлучаться в `rumor_spread`
   - rumor привязывается к новой локации и к actor entity ids
   - rumor имеет меньшую `importance`, чем исходное событие

6. Safe-by-default:
   - симуляция не меняет `player.hp`
   - симуляция не ставит `player.isDead=true`
   - симуляция не удаляет предметы из инвентаря
   - допустимы только мягкие последствия мира: пропущенная встреча, ухудшение отношения, смена наличия NPC, слухи, изменение состояния локации

### 5. Встраивание в request pipeline

Поменять последовательность `/api/action` так:

1. Нормализовать `sessionId`, `mentions`, `worldControl`.

2. Вызвать `worldSimulator.ensureRuntimeState()`.

3. До `getNextGameState()` вызвать `worldSimulator.runSimulation()`:
   - `trigger_type='idle_catchup'` при обычном ходе
   - `trigger_type='explicit_wait'` при `worldControl.mode='wait'`

4. После симуляции вызвать `worldSimulator.projectAuthoritativeScene()` и слить серверную проекцию с присланным `currentState`:
   - текущая локация берется из клиента, если это активное перемещение игрока
   - NPC в сцене, локальные incident markers и condition берутся из канона, если они устарели после idle catch-up
   - это убирает расхождение “клиент думает, что деревня прежняя, а канон уже другой”

5. Уже после этого вызывать `contextBuilder.buildContext()` и `getNextGameState()`.

6. После ответа ГМа оставлять текущий `recordTurn()` и весь state/memory pipeline как есть.

### 6. Изменения в Context Builder

`backend/contextBuilder.js` нужно расширить секцией `WORLD SIM SIGNALS`.

В нее попадают только события, которые:
- были созданы последним `world_sim_run`
- затрагивают текущую локацию игрока
- или связаны с `mentions`
- или ведут к due consequence в ближайших 1-3 шагах

Формат секции:
- короткие структурированные lines без prose
- не больше 5 строк
- примеры: “Trudy arrived in Goodsprings two hours ago”, “Rumors about the sabotaged wells reached Novac”, “Dusty Pete has been seen moving east”

Эта секция вставляется перед `DETERMINISTIC WORLD FACTS`, чтобы ГМ подавал изменения органически прямо в сцене.

### 7. Явный `wait/sleep/pass time`

Первая поставка не требует нового UI-виджета, но API и backend должны быть готовы.

1. На backend:
   - если `worldControl.mode='wait'`, не полагаться на LLM для самой прокрутки времени
   - сначала выполнить симуляцию на `requestedMinutes`
   - затем передать ГМу уже обновленный мир и player action вроде “wait at the village square” для органической сцены после ожидания

2. На frontend:
   - пока без отдельной панели времени
   - ближайший шаг: добавить 2-3 быстрые action button’ы типа `Wait 1 hour`, `Sleep until morning`, `Pass the day`
   - они просто вызывают `handlePlayerAction()` с text + `worldControl`

### 8. Сохранение и загрузка

Нужно исправить связность сейва и backend session.

1. Сейв должен хранить `sessionId` вместе с `gameState`.

2. При `handleLoadGame()` frontend обязан:
   - восстановить `sessionId` из save envelope
   - положить его обратно в `SESSION_STORAGE_KEY`
   - только потом продолжать игру

3. Это обязательно для world sim, иначе локальный сейв может открыться с неверной или пустой backend-сессией.

### 9. Observability

1. Каждый simulation run пишет строку в `world_sim_runs`.

2. В `turn_artifacts.metadata` добавить объект `world_sim`:
   - `trigger_type`
   - `applied`
   - `requested_minutes`
   - `applied_minutes`
   - `steps`
   - `events_generated`
   - `memories_generated`
   - `scene_changed`
   - `skipped_reason`

3. В `/api/memory-stats` вернуть последнее состояние runtime и последнюю simulation run summary.

### 10. Rollout

1. Выложить код с `WORLD_SIM_ENABLED=false`.

2. Применить миграцию `005_world_simulator_v1.sql`.

3. В staging включить `WORLD_SIM_ENABLED=true`.

4. Прогнать smoke и eval.

5. Только после зеленых тестов включить в рабочей среде.

## Important Changes To Existing Files

1. `backend/index.js`
   - принять `worldControl`
   - вызывать world simulator до `getNextGameState()`
   - расширить `/api/memory-stats`

2. `backend/contextBuilder.js`
   - добавить `WORLD SIM SIGNALS`
   - не смешивать их с обычным `RANKED MEMORY RETRIEVAL`

3. `backend/supabaseWorldService.js`
   - оставить CRUD/канон
   - добавить только низкоуровневые helper-методы, которые нужны `worldSimulator.js`
   - не переносить orchestration обратно в этот файл

4. `services/geminiService.ts`
   - поддержать `worldControl`
   - сохранить совместимость со старым вызовом

5. `App.tsx`
   - перевести save/load на `SaveEnvelope`
   - восстановление `sessionId` при загрузке
   - подготовить вызовы для future quick-actions `wait/sleep`

6. `types.ts`
   - `sessionId?: string`
   - `WorldControl`
   - `SaveEnvelope`

7. `README.md`
   - задокументировать world simulation env flags
   - описать catch-up model и safe-by-default semantics

8. `backend/README.md`
   - задокументировать pipeline симуляции и observability

9. `memory-plan.md`
   - добавить новый этап про autonomous world simulation как следующий stage после текущих memory stages

## Test Cases And Scenarios

1. Новый smoke test `tests/smoke-world-simulation.mjs`:
   - старт кампании
   - простой в безопасной локации
   - искусственно сдвинуть `last_simulated_at` назад
   - сделать обычный `/api/action`
   - проверить, что появились `world_sim_runs`, `world_idle_tick`, хотя игрок сам не перемещался

2. Новый сценарий `idle_village_life`:
   - игрок сидит в деревне
   - проходит длительное idle catch-up окно
   - в каноне появляются offscreen travel/rumor/encounter события
   - следующий ответ ГМа органически отражает изменения вокруг деревни

3. Новый сценарий `explicit_wait_same_engine`:
   - вызвать `/api/action` c `worldControl.mode='wait'`
   - проверить, что engine использовал `explicit_wait`
   - проверить, что канон обновился через тот же путь, что и idle catch-up

4. Новый сценарий `safe_idle_no_player_death`:
   - большой idle interval
   - у игрока не меняются `hp` и `isDead`
   - нет инвентарных потерь

5. Новый сценарий `encounter_after_offscreen_travel`:
   - NPC раньше виделся в одной локации
   - после catch-up он оффскрин перемещается к локации игрока
   - создается `encounter_hint`
   - он попадает в контекст следующего хода

6. Новый сценарий `save_load_restores_session_binding`:
   - сохранить игру
   - очистить runtime в браузере
   - загрузить игру
   - убедиться, что следующий ход пишет в ту же backend session и симуляция продолжает тот же world clock

7. Расширить `tests/eval-memory-gate.mjs` метриками:
   - `world_sim_run_rate`
   - `world_sim_scene_change_rate`
   - `idle_sync_latency_p95`
   - `offscreen_event_surface_rate`

8. Расширить `tests/release-gate.mjs`, чтобы он запускал новый smoke alongside existing smoke/eval.

## Acceptance Criteria

1. Мир может измениться без участия игрока, и эти изменения фиксируются в каноне до следующего GM-ответа.

2. Первый ход после долгой паузы видит уже обновленный канон, а не только старый клиентский state.

3. Явное ожидание (`wait/sleep`) использует тот же engine, а не отдельную ad-hoc механику.

4. Игрок не умирает и не теряет HP оффскрин в v1.

5. `turn_artifacts.metadata.world_sim` и `world_sim_runs` позволяют понять, что произошло и почему.

6. Все существующие memory, consequences, reflection и GraphRAG-фичи продолжают работать поверх нового канона без regressions.

## Assumptions And Defaults

1. Первая версия не делает настоящий always-on background worker. Используем только `idle catch-up` на следующем взаимодействии.

2. Первая версия не вводит отдельный UI для журнала мира и не меняет визуальную подачу на фронте.

3. Первая версия не строит экономику поселений, торговые цепочки и полный faction simulation.

4. Источником истины остаются существующие `events`, `entity_state`, `relations`, `quest_state`. Симулятор только пишет новые каноничные события и проекции.

5. Для NPC routing в v1 достаточно известных локаций и `home/current_location` в `entity_state.state.world`; pathfinding не нужен.

6. По умолчанию:
   - minimum idle window: `180` секунд
   - scale: `1 real minute = 10 game minutes`
   - auto catch-up cap: `1440` game minutes
   - explicit wait cap: `4320` game minutes
   - step size: `60` game minutes
   - idle mode: `safe`

7. Если симуляция падает, `/api/action` не должен ломаться: backend пишет `skipped_reason` и продолжает обычный ход без world sim.

# poker-engine-ts

目前最完整的开源、事件溯源扑克引擎，为生产后端而造。

[English](https://github.com/Ge-limin/poker-engine-ts/blob/main/README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/poker-engine-ts.svg)](https://www.npmjs.com/package/poker-engine-ts)
[![CI](https://github.com/Ge-limin/poker-engine-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/Ge-limin/poker-engine-ts/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#许可)

欢迎在 **[在线演练场](https://ge-limin.github.io/poker-engine-ts/)** 探索引擎的各项特性。您可以通过公开 API 与机器人对局、从事件日志中销毁并重建会话、在任意决策点分叉时间线，以及单步调试复杂的规则交互。

## 这是什么

这个库为在服务器应用中运行真实的扑克牌局提供了核心机制。其本质上是一个扑克状态机。构建扑克引擎最困难的部分是正确地管理状态转换：轮到谁行动、哪些行动是合法的、下注回合何时结束，以及像短码全下（short all-in）这样的边缘情况是否——或如何不——重新开启行动。

该引擎的解决之道，是将游戏规则建模为数据，并将游戏状态实现为对一个只追加（append-only）事件日志的纯粹归约（pure reduction）。这种事件溯源（event-sourced）的架构意味着，状态机的正确性可以通过从日志中重放一局牌来验证，确保重建的牌桌状态与实时状态完全一致。它也保证了复杂场景——例如多方不等额全下形成的边池——能够被正确计算。筹码守恒性（chip conservation）则通过属性测试（property-based tests）进行验证，这些测试运行随机的行动序列，确保在任何场景下数学计算都准确无误。

引擎的底层设计是与具体玩法无关的（variant-agnostic）。发牌、下注和摊牌的规则都在一个 `RuleSetDescriptor` 中定义。目前，它提供了一套完整且经过充分测试的德州扑克（Texas Hold'em）实现（包括无限注、底池限注和固定限注）。其核心只有一个运行时依赖（`@noble/hashes`），并且完全同构（isomorphic），能在 Node.js、浏览器和边缘环境中以完全相同的方式运行。

## 安装

```bash
npm install poker-engine-ts
```

核心包是自包含的。用于持久化和客户端集成的可选适配器可以独立安装，只有在您导入它们时，其对等的依赖项才会被引入。

```bash
# 仅 poker-engine-ts/persistence/supabase 需要
npm install @supabase/supabase-js

# 仅 poker-engine-ts/adapters/client 需要
npm install react
```

该包以 ESM 格式分发，并通过捆绑的 `.d.ts` 文件提供完整的 TypeScript 支持。

## 快速上手

此示例演示了如何使用公开 API 运行一局完整的牌，从牌桌配置到摊牌。所有出现的符号都从主包中导出。

```ts
import {
  SessionManager,
  selectDecisionContext,
  selectTableView,
} from 'poker-engine-ts';
import type {
  Card,
  SeatBootstrapConfig,
  SessionConfig,
} from 'poker-engine-ts';

// Describe the table. bettingStructure: 'no-limit' | 'pot-limit' | 'fixed-limit'.
// autoAdvance lets the engine roll streets forward and settle on its own.
const config: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'no-limit',
  maxSeats: 2,
  startingStack: 100,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
  personaPolicy: { defaultStyle: 'balanced' },
  ruleSet: {
    streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
    postingOrder: ['small-blind', 'big-blind'],
    minRaisePolicy: 'double-last-bet',
    showdownOrdering: 'high-card',
    cardDistribution: {
      holeCardsPerPlayer: 2,
      burnPerStreet: [0, 1, 1],
      communityReveal: [0, 3, 1, 1],
    },
  },
  evaluationPolicy: {
    engine: 'lookup-table',
    evaluatorId: 'default',
    supportsHiLo: false,
    cacheSize: 1024,
  },
  autoAdvance: true,
};

const seats: readonly SeatBootstrapConfig[] = [
  { playerId: 'hero', seatIndex: 0, stack: 100 },
  { playerId: 'villain', seatIndex: 1, stack: 100 },
];

// A fixed, ordered deck feeds the community board as streets auto-advance.
const deck: readonly Card[] = [
  'As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s',
];

// The event log is the source of truth; the manager holds the reduced
// TableSnapshot plus checkpoints for replay.
const manager = SessionManager.create(config, seats, { deck });

// Drive the hand: ask the engine whose turn it is and what is legal, then
// submit one intent per decision. Checking and calling runs the board out.
for (let guard = 0; guard < 100; guard += 1) {
  const decision = selectDecisionContext(manager.session);
  if (!decision.actor) break; // nobody left to act: settled or run out

  const legal = decision.availableActions.filter((o) => !o.disabled);
  const choice =
    legal.find((o) => o.type === 'check') ??
    legal.find((o) => o.type === 'call');
  if (!choice) break;

  const result = await manager.applyIntent({
    id: `${decision.actor}-${guard}`,
    actor: decision.actor,
    requested:
      choice.type === 'call'
        ? { type: 'call', amount: choice.amount }
        : { type: 'check' },
    origin: 'ui',
    issuedAt: Date.now(),
    expectedSnapshotVersion: manager.session.activeSnapshot.index,
  });
  if (result.validation.kind !== 'accepted') {
    throw new Error(`intent rejected: ${result.validation.reason}`);
  }
}

const table = selectTableView(manager.session);
console.log('stage', manager.session.activeSnapshot.hand.stage); // 'showdown'
console.log('board', table.board.flop, table.board.turn, table.board.river);
console.log('pot  ', table.potTotal);
```

请注意，`SessionManager.create` 使用了提供的牌库来发公共牌，但默认情况下不发底牌。在这个过牌/跟注的场景中，牌局在只剩一名玩家时结束，没有进行比牌摊牌。对于涉及发底牌和评估牌力大小的牌局，请参考演练场中使用的 `generateRandomState` 和 `advanceRandomState` 函数。此示例的可运行版本位于 [`examples/quickstart.ts`](./examples/quickstart.ts)（`pnpm example:quickstart`）。

## 演示

一个交互式演练场托管在 [ge-limin.github.io/poker-engine-ts](https://ge-limin.github.io/poker-engine-ts/)，也可以从 [`examples/playground`](./examples/playground) 目录在本地运行。它通过其公开 API 全面展示了引擎的功能。该演示分为四个标签页：

-   **亲手玩一局**：与三个机器人对局，每个行动都由 `applyIntent` 处理。您可以在任何时候终止会话，并从事件日志中重建它，通过逐字段的差异对比来证明重建的状态与原始状态完全一致。
-   **复盘与分叉**：在任何一手牌的时间线上拖动，查看每个决策点的牌桌状态。您还可以在任何一点选择一个不同的合法行动来“分叉”时间线，创造一个新的历史分支。
-   **规则实验室**：逐步演示锦标赛中的短码全下规则，其中后续玩家的加注选项被正确禁用。
-   **压力测试**：在一个连续循环中运行牌局，在每一次行动后重新验证筹码守恒的不变量，以确保系统在数千手牌后仍然保持完整性。

要在本地运行此演示：

```bash
pnpm install
pnpm --filter playground dev
```

## 特性

-   **事件溯源架构**：只追加的事件日志是唯一的真相来源。牌桌状态是事件的纯粹归约（`reduce(snapshot, event)`），这使得会话可以从其日志中完美地“再水合”（rehydrate）。此设计也为 `rewindTo` 和 `replaceFrom` 等时间线功能提供了动力。事件带有版本信息，以确保与旧日志的向后兼容。
-   **四种运行时模式**：单一的 `RuntimeContext` 支持四种不同的操作模式——`live`、`replay`、`simulation` 和 `scenario`——并带有类型化的运行时守卫，以防止非法的状态转换。
-   **精确的边池计算**：`PotLedger` 和 `PayoutSummary` 对象能够正确管理和解决复杂的多路全下场景，确保每个玩家都能分得主池和边池中正确的部分。
-   **定制的手牌评估器**：7 张牌的德州扑克评估器是为完全控制而手动编写的，没有像 `pokersolver` 或 `treys` 这样的外部依赖。
-   **经过属性测试的筹码守恒**：我们使用 `fast-check` 生成随机的行动序列，并断言账本不变量和筹码总额在每一次状态转换（包括摊牌和结算）中都得以维持。这为边池逻辑等最难处理的部分的正确性提供了强有力的保证。
-   **并发安全的 API**：对 `applyIntent` 的调用通过一个异步互斥锁进行序列化，确保针对单个会话的并发请求能够安全、有序地处理。
-   **同构核心**：引擎只有一个运行时依赖（`@noble/hashes`），并且在 Node.js、浏览器和边缘计算环境中运行同样的代码。
-   **TypeScript 优先**：该库使用 TypeScript 编写，并通过其生成的 `.d.ts` 声明文件提供完整的类型定义。

## 可选适配器

核心引擎与持久化和 UI 问题解耦。`SessionManager` 与一个最小化的 `SessionRepository` 接口（`get`、`set` 和可选的钩子）交互，该接口可以用任何数据库实现。`createServerSessionAdapter` 用于接入您选择的实现。

-   **poker-engine-ts/persistence/supabase**：提供了一个用于 Supabase 的具体 `SessionRepository` 实现 `createSupabaseSessionRepository`，以及用于牌局历史和实时更新的辅助工具。这可以作为其他适配器（如 Postgres、Redis 或本地文件系统）的蓝图。需要可选的对等依赖 `@supabase/supabase-js`。
-   **poker-engine-ts/adapters/client**：包含用于客户端应用的工具，例如 `createClientSessionAdapter`、React 钩子（`useSessionView`、`useScenarioTimeline`）和纯视图辅助函数。需要可选的对等依赖 `react`。
-   **poker-engine-ts/testing**：一套用于编写测试和模拟的内存辅助工具，包括 `createSeededRandom` 和 `runHeadlessRandomState`。
-   **poker-engine-ts/format**：一个无依赖的渲染层，可将引擎输出转换为人类可读的文本，适用于从 UI 标签到可重放事件时间线的各种场景。

## 和同类项目的对比

开源扑克生态系统中有一些用于学术研究和博弈论求解的出色工具。这个引擎与它们不同：它的构建目标是承担在生产后端运行实时扑克游戏这一“不那么光鲜”但承重巨大的工作。

-   **PokerKit**（多伦多大学，IEEE Transactions on Games 2025）是模拟和牌谱记法（hand notation）的参考标准，支持超过 14 种变体。对于学术研究、离线分析或任何需要可引用的 PHH 记法格式的工作，PokerKit 是更优越的工具。

-   **rs-poker** 是一个用于高性能评估和求解的先进 Rust 工具包，拥有约 20 纳秒的手牌评估速度、CFR、ICM 计算和 PLO 支持。对于构建求解器或训练机器人，rs-poker 是正确的选择，本引擎不试图在该领域竞争。

本库的重点是实时游戏服务器所面临的特定挑战：为回放和审计维护一个权威的事件日志、确保边池计算的数学正确性、为任何数据库提供可插拔的持久化层，以及提供一个在服务器、浏览器和边缘环境中表现一致的核心。

## 范围

`poker-engine-ts` 目前实现了德州扑克，支持无限注、底池限注和固定限注的下注结构，以及 2 人、6 人或 9 人的牌桌。

在这个单一变体的底层，是一个用于发牌、下注、全下补牌（runout）、摊牌和持久化的通用引擎。该架构被设计为可扩展的；添加像奥马哈（Omaha）这样的另一种公共牌变体，将主要涉及为评估器实现一个新的选牌规则，因为周边的接口已经就位。

## 测试

该库经过了广泛的测试，测试代码（约 10.8k 行）与引擎代码（约 11.6k 行）的数量大致相当。其中很大一部分专门用于 `fast-check` 的属性测试。这些测试生成随机的玩家行动序列，以验证那些必须始终成立的不变量：游戏中的总筹码量永远不变，底池账本在内部保持一致，以及筹码在涉及不等筹码的复杂摊牌中保持守恒。这种严格的测试为那些最难正确的逻辑（例如多路全下的边池计算）提供了高度的信心。

## 许可

MIT。版权归 Limin 所有。

由 [liminge studio](https://liminge.space) 出品。

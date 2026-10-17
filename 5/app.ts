/* ==========================================================================
 * 五子棋 · TypeScript 单文件版（跨局冻结规则）
 *
 * 特点：
 *   - 单文件、零 import，一个 tsc 命令就能编译，不需要 npm / 打包器
 *   - 编译产物 app.js 用 <script> 直接引入，双击 index.html 即可玩
 *   - 不联网、不起服务器
 *
 * 自创规则：
 *   - 30×30 棋盘，五局三胜（先得 3 分者赢得整场）
 *   - 每局五连得 1 分，本局立即结束；棋盘跨局保留，不清空
 *   - 获胜连线立即从棋盘移除：恰好五连移除五颗，六连及以上移除整条连续棋子
 *   - 每局结束后，用“剩余棋子”生成下一局的冻结区域：
 *     每颗棋子自身及周围 3×3 全部冻结
 *   - 下一局开始后随机 5–15 手内解除冻结；解除前不能落在冻结区
 *
 * 修改后重新生成 app.js：
 *     tsc app.ts --target ES2017
 *   （只要本机装了 TypeScript；没装则直接玩现有的 app.js 即可）
 * ========================================================================== */

(() => {
  /* ------------------------------- 常量 ------------------------------- */

  const BOARD_SIZE: number = 30;
  const WIN_LENGTH = 5;
  const WIN_SCORE = 3;
  const FREEZE_MIN_STEPS = 5;
  const FREEZE_MAX_STEPS = 15;

  const Stone = { Empty: 0, Black: 1, White: 2 } as const;

  type StoneValue = (typeof Stone)[keyof typeof Stone];
  type Player = typeof Stone.Black | typeof Stone.White;
  type Board = StoneValue[];

  interface Move {
    row: number;
    col: number;
  }

  type GameStatus = 'playing' | 'black-win' | 'white-win' | 'draw';

  interface Scores {
    black: number;
    white: number;
  }

  /** 完整状态快照，用于撤销本局最后一手（包括制胜手/和棋手） */
  interface Snapshot {
    board: Board;
    history: Move[];
    current: Player;
    finished: GameStatus;
    winLine: Move[];
    scores: Scores;
    round: number;
    matchOver: boolean;
    matchWinner: Player | null;
    frozen: boolean[];
    roundFrozen: boolean[];
    freezeReleaseMove: number;
    freezeMovesLeft: number;
  }

  /** 横、竖、主对角、副对角 */
  const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  function opponent(player: Player): Player {
    return player === Stone.Black ? Stone.White : Stone.Black;
  }

  function stoneName(stone: StoneValue): string {
    if (stone === Stone.Black) return '黑棋';
    if (stone === Stone.White) return '白棋';
    return '空';
  }

  function inBounds(row: number, col: number): boolean {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
  }

  function cellIndex(row: number, col: number): number {
    return row * BOARD_SIZE + col;
  }

  /** [min, max] 闭区间内的随机整数 */
  function randomInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function emptyBoard(): Board {
    const cells: Board = [];
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i += 1) cells.push(Stone.Empty);
    return cells;
  }

  function emptyFlags(): boolean[] {
    return new Array<boolean>(BOARD_SIZE * BOARD_SIZE).fill(false);
  }

  function hasAnyFlag(flags: boolean[]): boolean {
    for (let i = 0; i < flags.length; i += 1) {
      if (flags[i]) return true;
    }
    return false;
  }

  /**
   * 冻结区域：以每颗仍然存在的棋子为中心的 3×3。
   * 已经被移除的获胜连线不在棋盘上，因此不会产生冻结区域。
   */
  function buildFreezeZones(board: Board): boolean[] {
    const frozen = emptyFlags();

    for (let i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty) continue;

      const row = Math.floor(i / BOARD_SIZE);
      const col = i % BOARD_SIZE;

      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const r = row + dr;
          const c = col + dc;
          if (inBounds(r, c)) frozen[cellIndex(r, c)] = true;
        }
      }
    }

    return frozen;
  }

  /** 是否还有“空且未冻结”的位置可以落子 */
  function hasLegalMove(board: Board, frozen: boolean[]): boolean {
    for (let i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty && !frozen[i]) return true;
    }
    return false;
  }

  /* ------------------------------- 规则 ------------------------------- */

  /** 判断这一手是否凑成五连（双向计数，长连也算胜） */
  function isWinningMove(board: Board, move: Move, player: Player): boolean {
    const row = move.row;
    const col = move.col;
    if (board[cellIndex(row, col)] !== player) return false;

    for (const [dr, dc] of DIRECTIONS) {
      let count = 1;

      for (const sign of [1, -1] as const) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (inBounds(r, c) && board[cellIndex(r, c)] === player) {
          count += 1;
          r += dr * sign;
          c += dc * sign;
        }
      }

      if (count >= WIN_LENGTH) return true;
    }

    return false;
  }

  /**
   * 本次获胜实际要移除的连续棋子。
   *
   * 规则明确且稳定：
   *   1. 方向按 横 → 竖 → 主对角 → 副对角 的固定顺序检查。
   *   2. 一手同时形成多个方向五连时，取最长的一条；
   *      长度相同则取固定顺序中的第一条方向。
   *   3. 恰好五连时移除五颗；六连及以上时，把该方向连续的棋子全部移除。
   */
  function findWinningLine(board: Board, move: Move, player: Player): Move[] {
    const row = move.row;
    const col = move.col;
    if (board[cellIndex(row, col)] !== player) return [];

    let bestLine: Move[] = [];

    for (const [dr, dc] of DIRECTIONS) {
      const line: Move[] = [{ row, col }];

      for (const sign of [1, -1] as const) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (inBounds(r, c) && board[cellIndex(r, c)] === player) {
          line.push({ row: r, col: c });
          r += dr * sign;
          c += dc * sign;
        }
      }

      if (line.length >= WIN_LENGTH && line.length > bestLine.length) {
        line.sort((a, b) => a.row - b.row || a.col - b.col);
        bestLine = line;
      }
    }

    return bestLine;
  }

  /* ------------------------------- 对局 ------------------------------- */

  /** 纯逻辑的对局状态：不认识 canvas，也不认识 AI */
  class Game {
    board: Board = emptyBoard();
    history: Move[] = [];
    current: Player = Stone.Black;
    finished: GameStatus = 'playing';
    winLine: Move[] = [];

    /** 整场比分与局数 */
    scores: Scores = { black: 0, white: 0 };
    round = 1;
    matchOver = false;
    matchWinner: Player | null = null;

    /** 本局当前生效的冻结区；到达随机解除步数后清空 */
    frozen: boolean[] = emptyFlags();
    /** 本局开始时固定的冻结区，悔棋时用来恢复 */
    roundFrozen: boolean[] = emptyFlags();
    /** 本局随机抽取的冻结解除步数（5–15；0 表示本局没有冻结区） */
    freezeReleaseMove = 0;
    /** 距离解冻还剩多少手（0 表示已解冻或本局没有冻结区） */
    freezeMovesLeft = 0;

    /** 本局结束前最后一手的完整快照，用于撤销制胜手/和棋手 */
    roundEndSnapshot: Snapshot | null = null;

    at(row: number, col: number): StoneValue {
      return this.board[cellIndex(row, col)];
    }

    isOver(): boolean {
      return this.finished !== 'playing' || this.matchOver;
    }

    isRoundOver(): boolean {
      return this.finished !== 'playing';
    }

    isMatchOver(): boolean {
      return this.matchOver;
    }

    lastMove(): Move | null {
      return this.history.length > 0 ? this.history[this.history.length - 1] : null;
    }

    scoreOf(player: Player): number {
      return player === Stone.Black ? this.scores.black : this.scores.white;
    }

    snapshot(): Snapshot {
      return {
        board: this.board.slice(),
        history: this.history.slice(),
        current: this.current,
        finished: this.finished,
        winLine: this.winLine.slice(),
        scores: { black: this.scores.black, white: this.scores.white },
        round: this.round,
        matchOver: this.matchOver,
        matchWinner: this.matchWinner,
        frozen: this.frozen.slice(),
        roundFrozen: this.roundFrozen.slice(),
        freezeReleaseMove: this.freezeReleaseMove,
        freezeMovesLeft: this.freezeMovesLeft,
      };
    }

    restore(snapshot: Snapshot): void {
      this.board = snapshot.board.slice();
      this.history = snapshot.history.slice();
      this.current = snapshot.current;
      this.finished = snapshot.finished;
      this.winLine = snapshot.winLine.slice();
      this.scores = { black: snapshot.scores.black, white: snapshot.scores.white };
      this.round = snapshot.round;
      this.matchOver = snapshot.matchOver;
      this.matchWinner = snapshot.matchWinner;
      this.frozen = snapshot.frozen.slice();
      this.roundFrozen = snapshot.roundFrozen.slice();
      this.freezeReleaseMove = snapshot.freezeReleaseMove;
      this.freezeMovesLeft = snapshot.freezeMovesLeft;
    }

    canUndo(): boolean {
      if (this.roundEndSnapshot) return true;
      return !this.isOver() && this.history.length > 0;
    }

    canPlay(move: Move): boolean {
      if (this.isOver()) return false;
      if (!inBounds(move.row, move.col)) return false;
      const index = cellIndex(move.row, move.col);
      return this.board[index] === Stone.Empty && !this.frozen[index];
    }

    /**
     * 本局结束：记分、移除获胜连线、根据剩余棋子生成下一局冻结区。
     * 如果下一局已经没有任何可落子的位置，则整场和棋。
     */
    private finishRound(
      result: GameStatus,
      winner: Player | null,
      winningLine: Move[],
    ): void {
      this.finished = result;
      this.winLine = winningLine;

      if (winner !== null) {
        const side: 'black' | 'white' = winner === Stone.Black ? 'black' : 'white';
        this.scores[side] += 1;
        if (this.scores[side] >= WIN_SCORE) {
          this.matchOver = true;
          this.matchWinner = winner;
        }
      }

      // 先移除获胜连线（五连或更长），再用“仍然存在”的棋子生成冻结区。
      for (const cell of winningLine) {
        this.board[cellIndex(cell.row, cell.col)] = Stone.Empty;
      }

      this.frozen = buildFreezeZones(this.board);
      this.roundFrozen = this.frozen.slice();
      // 下一局开始时再随机抽取 5–15 的解除步数。
      this.freezeReleaseMove = 0;
      this.freezeMovesLeft = 0;

      if (!this.matchOver && !hasLegalMove(this.board, this.frozen)) {
        // 棋盘已经无法继续下一局（例如几乎没有空位）。
        this.matchOver = true;
        this.matchWinner = null;
      }
    }

    /** 落子；非法则返回 false */
    play(move: Move): boolean {
      if (!this.canPlay(move)) return false;

      const before = this.snapshot();
      const player = this.current;
      const index = cellIndex(move.row, move.col);
      this.board[index] = player;
      this.history.push({ row: move.row, col: move.col });

      const winningLine = findWinningLine(this.board, move, player);
      if (winningLine.length > 0) {
        this.finishRound(player === Stone.Black ? 'black-win' : 'white-win', player, winningLine);
        this.roundEndSnapshot = before;
        return true;
      }

      // 冻结区仍然有效；到达本局随机抽取的解除步数后一次性全部解除。
      if (this.freezeMovesLeft > 0) {
        this.freezeMovesLeft -= 1;
        if (this.freezeMovesLeft === 0) {
          this.frozen = emptyFlags();
        }
      }

      // 没有“空且未冻结”的位置：本局和棋。
      if (!hasLegalMove(this.board, this.frozen)) {
        this.finishRound('draw', null, []);
        this.roundEndSnapshot = before;
        return true;
      }

      this.roundEndSnapshot = null;
      this.current = opponent(player);
      return true;
    }

    /** 开始下一局：棋盘和比分保留，只重置本局落子记录与冻结倒计时 */
    startNextRound(): boolean {
      if (this.matchOver || !this.isRoundOver()) return false;

      // 进入下一局后，不能再悔棋回到上一局。
      this.roundEndSnapshot = null;
      this.round += 1;
      this.history = [];
      this.current = Stone.Black;
      this.finished = 'playing';
      this.winLine = [];

      this.roundFrozen = this.frozen.slice();
      if (hasAnyFlag(this.roundFrozen)) {
        // 每局开始时随机抽取：前 N 手受冻结限制，第 N 手落完后解除。
        this.freezeReleaseMove = randomInt(FREEZE_MIN_STEPS, FREEZE_MAX_STEPS);
        this.freezeMovesLeft = this.freezeReleaseMove;
        this.frozen = this.roundFrozen.slice();
      } else {
        this.freezeReleaseMove = 0;
        this.freezeMovesLeft = 0;
        this.frozen = emptyFlags();
      }

      if (!hasLegalMove(this.board, this.frozen)) {
        this.finishRound('draw', null, []);
        return false;
      }

      return true;
    }

    /** 悔棋 steps 手（可以撤销本局最后一手，包括制胜手/和棋手） */
    undo(steps = 1): boolean {
      if (this.isOver()) {
        if (!this.roundEndSnapshot) return false;
        const snapshot = this.roundEndSnapshot;
        this.roundEndSnapshot = null;
        this.restore(snapshot);
        return true;
      }

      let undone = false;

      for (let i = 0; i < steps && this.history.length > 0; i += 1) {
        const last = this.history.pop() as Move;
        this.board[cellIndex(last.row, last.col)] = Stone.Empty;
        this.current = opponent(this.current);
        undone = true;
      }

      if (undone) {
        this.roundEndSnapshot = null;
        this.finished = 'playing';
        this.winLine = [];

        // 退回本局随机解除步数之前时，恢复本局开始时固定的冻结区。
        if (hasAnyFlag(this.roundFrozen) && this.history.length < this.freezeReleaseMove) {
          this.frozen = this.roundFrozen.slice();
          this.freezeMovesLeft = this.freezeReleaseMove - this.history.length;
        } else {
          this.frozen = emptyFlags();
          this.freezeMovesLeft = 0;
        }
      }

      return undone;
    }

    reset(): void {
      this.board = emptyBoard();
      this.history = [];
      this.current = Stone.Black;
      this.finished = 'playing';
      this.winLine = [];
      this.scores = { black: 0, white: 0 };
      this.round = 1;
      this.matchOver = false;
      this.matchWinner = null;
      this.frozen = emptyFlags();
      this.roundFrozen = emptyFlags();
      this.freezeReleaseMove = 0;
      this.freezeMovesLeft = 0;
      this.roundEndSnapshot = null;
    }
  }

  /* -------------------------------- AI -------------------------------- */

  /** 各棋型权重 */
  const SHAPE = {
    five: 10000000,
    openFour: 400000,
    four: 40000,
    openThree: 20000,
    three: 2000,
    openTwo: 1500,
    two: 200,
    one: 20,
  };

  const ATTACK_BIAS = 1.15;

  interface AiOptions {
    depth?: number;
    width?: number;
    timeBudgetMs?: number;
    /** 当前冻结区；AI 不会在这些位置落子 */
    frozen?: boolean[] | null;
  }

  interface SearchContext {
    me: Player;
    deadline: number;
    nodes: number;
    aborted: boolean;
    frozen: boolean[] | null;
  }

  function at(board: Board, row: number, col: number): StoneValue {
    if (!inBounds(row, col)) return Stone.Empty;
    return board[cellIndex(row, col)];
  }

  /** 单方向形状分：假设 (row,col) 已是 player 的子，数连子与两端开口 */
  function shapeScore(board: Board, row: number, col: number, player: Player): number {
    let best = 0;

    for (const [dr, dc] of DIRECTIONS) {
      let count = 1;
      let openEnds = 0;
      let jump = 0;

      for (const sign of [1, -1] as const) {
        let r = row + dr * sign;
        let c = col + dc * sign;

        while (at(board, r, c) === player) {
          count += 1;
          r += dr * sign;
          c += dc * sign;
        }

        if (at(board, r, c) === Stone.Empty) {
          openEnds += 1;
          if (at(board, r + dr * sign, c + dc * sign) === player) jump += 1;
        }
      }

      let score: number;
      if (count >= WIN_LENGTH) {
        score = SHAPE.five;
      } else if (count === 4) {
        score = openEnds >= 2 ? SHAPE.openFour : openEnds === 1 ? SHAPE.four : 0;
      } else if (count === 3) {
        score = openEnds >= 2 ? SHAPE.openThree : openEnds === 1 ? SHAPE.three : 0;
      } else if (count === 2) {
        score = openEnds >= 2 ? SHAPE.openTwo : openEnds === 1 ? SHAPE.two : 0;
      } else {
        score = openEnds > 0 ? SHAPE.one : 0;
      }

      if (jump > 0 && count < WIN_LENGTH) score *= 2;

      if (score > best) best = score;
    }

    return best;
  }

  /** 这个点的价值：自己进攻 + 顺便封堵对手 */
  function moveScore(board: Board, move: Move, me: Player): number {
    const index = cellIndex(move.row, move.col);
    const previous = board[index];
    const them = opponent(me);

    board[index] = me;
    const attack = shapeScore(board, move.row, move.col, me);

    board[index] = them;
    const block = shapeScore(board, move.row, move.col, them);

    board[index] = previous;
    return attack * ATTACK_BIAS + block;
  }

  /** 全盘评估：我方 - 对方 */
  function evaluate(board: Board, me: Player): number {
    const them = opponent(me);
    let mine = 0;
    let theirs = 0;

    for (let i = 0; i < board.length; i += 1) {
      const stone = board[i];
      if (stone === Stone.Empty) continue;

      const row = Math.floor(i / BOARD_SIZE);
      const col = i % BOARD_SIZE;
      if (stone === me) mine += shapeScore(board, row, col, me) / 5;
      else theirs += shapeScore(board, row, col, them) / 5;
    }

    return mine - theirs * 1.1;
  }

  /** 所有“已有棋子附近 radius 格”内、且未冻结的空位 */
  function nearbyCells(board: Board, radius: number, frozen: boolean[] | null): Move[] {
    const seen: boolean[] = [];
    const result: Move[] = [];

    for (let i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty) continue;

      const baseRow = Math.floor(i / BOARD_SIZE);
      const baseCol = i % BOARD_SIZE;

      for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
          const r = baseRow + dr;
          const c = baseCol + dc;
          if (!inBounds(r, c)) continue;

          const index = cellIndex(r, c);
          if (board[index] !== Stone.Empty || seen[index]) continue;
          if (frozen && frozen[index]) continue;

          seen[index] = true;
          result.push({ row: r, col: c });
        }
      }
    }

    return result;
  }

  /** 全盘所有可落子的空位（冻结区之外） */
  function allLegalCells(board: Board, frozen: boolean[] | null): Move[] {
    const result: Move[] = [];
    for (let i = 0; i < board.length; i += 1) {
      if (board[i] !== Stone.Empty) continue;
      if (frozen && frozen[i]) continue;

      result.push({ row: Math.floor(i / BOARD_SIZE), col: i % BOARD_SIZE });
    }
    return result;
  }

  /**
   * 候选点按价值排序后截取前 width 个。
   * 冻结开局时棋子附近可能全是冻结区，此时退化为全盘合法空位，
   * 并用轻微的中心偏好打破形状分相同的平局。
   */
  function orderedMoves(
    board: Board,
    me: Player,
    width: number,
    frozen: boolean[] | null,
  ): Move[] {
    let cells = nearbyCells(board, 2, frozen);
    let usedFallback = false;

    if (cells.length === 0) {
      cells = allLegalCells(board, frozen);
      usedFallback = true;
    }

    if (cells.length === 0) return [];

    const centerCoord = (BOARD_SIZE - 1) / 2;

    const scored = cells
      .map((move) => {
        let score = moveScore(board, move, me);
        if (usedFallback) {
          const distance =
            Math.abs(move.row - centerCoord) + Math.abs(move.col - centerCoord);
          score += (BOARD_SIZE * 2 - distance) * 0.01;
        }
        return { move, score };
      })
      .sort((a, b) => b.score - a.score);

    const result: Move[] = [];
    for (let i = 0; i < scored.length && i < width; i += 1) result.push(scored[i].move);
    return result;
  }

  /** player 现在就能成五的点 */
  function immediateWins(
    board: Board,
    player: Player,
    frozen: boolean[] | null,
    limit = 4,
  ): Move[] {
    let cells = nearbyCells(board, 2, frozen);
    if (cells.length === 0) cells = allLegalCells(board, frozen);

    const wins: Move[] = [];

    for (const move of cells) {
      const index = cellIndex(move.row, move.col);

      board[index] = player;
      const win = isWinningMove(board, move, player);
      board[index] = Stone.Empty;

      if (win) {
        wins.push(move);
        if (wins.length >= limit) break;
      }
    }

    return wins;
  }

  function negamax(
    board: Board,
    depth: number,
    alpha: number,
    beta: number,
    player: Player,
    ctx: SearchContext,
  ): number {
    ctx.nodes += 1;

    if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) {
      ctx.aborted = true;
      return evaluate(board, ctx.me);
    }

    if (depth === 0) {
      return player === ctx.me ? evaluate(board, ctx.me) : -evaluate(board, ctx.me);
    }

    const moves = orderedMoves(board, player, depth >= 3 ? 8 : 10, ctx.frozen);
    if (moves.length === 0) return 0;

    const maximizing = player === ctx.me;
    let best = maximizing ? -Infinity : Infinity;

    for (const move of moves) {
      const index = cellIndex(move.row, move.col);
      board[index] = player;

      let value: number;
      if (isWinningMove(board, move, player)) {
        value = maximizing ? 1000000 + depth * 1000 : -(1000000 + depth * 1000);
      } else {
        value = negamax(board, depth - 1, alpha, beta, opponent(player), ctx);
      }

      board[index] = Stone.Empty;

      if (maximizing) {
        if (value > best) best = value;
        if (best > alpha) alpha = best;
      } else {
        if (value < best) best = value;
        if (best < beta) beta = best;
      }

      if (beta <= alpha) break;
      if (ctx.aborted) break;
    }

    return best;
  }

  /**
   * 选点顺序：我能成五 → 堵对手成五 → α-β 搜索。
   * 传入的棋盘不会被修改（内部先复制）。
   */
  function findBestMove(
    board: Board,
    me: Player,
    options: AiOptions = {},
  ): Move | null {
    const depth = options.depth !== undefined ? options.depth : 3;
    const width = options.width !== undefined ? options.width : 10;
    const timeBudgetMs = options.timeBudgetMs !== undefined ? options.timeBudgetMs : 1000;
    const frozen = options.frozen !== undefined ? options.frozen : null;

    const work = board.slice();

    const wins = immediateWins(work, me, frozen);
    if (wins.length > 0) return wins[0];

    const blocks = immediateWins(work, opponent(me), frozen);
    if (blocks.length > 0) return blocks[0];

    const ctx: SearchContext = {
      me,
      deadline: Date.now() + timeBudgetMs,
      nodes: 0,
      aborted: false,
      frozen,
    };

    const rootMoves = orderedMoves(work, me, width, frozen);
    if (rootMoves.length === 0) return null;

    let best: Move = rootMoves[0];
    let bestValue = -Infinity;

    for (const move of rootMoves) {
      const index = cellIndex(move.row, move.col);
      work[index] = me;

      const value = isWinningMove(work, move, me)
        ? 10000000
        : negamax(work, depth - 1, -Infinity, Infinity, opponent(me), ctx);

      work[index] = Stone.Empty;

      if (value > bestValue) {
        bestValue = value;
        best = move;
      }

      if (ctx.aborted) break;
    }

    return best;
  }

  /* ------------------------------ 渲染器 ------------------------------ */

  const COLORS = {
    board: '#e3b673',
    boardEdge: '#c8964f',
    line: '#7a5326',
    black: '#1c1c20',
    lastMove: '#e03b3b',
    winLine: '#ffcf33',
    hint: 'rgba(30, 110, 220, 0.35)',
    frozen: 'rgba(86, 156, 214, 0.24)',
    frozenEdge: 'rgba(60, 130, 200, 0.38)',
  };

  interface RenderState {
    board: Board;
    lastMove: Move | null;
    winningLine: Move[];
    frozen: boolean[];
    isOver: boolean;
  }

  /** 星位随棋盘大小生成；30×30 用四角 + 中心 */
  function starPoints(): ReadonlyArray<readonly [number, number]> {
    if (BOARD_SIZE === 15) {
      const stars: ReadonlyArray<readonly [number, number]> = [
        [3, 3],
        [3, 11],
        [11, 3],
        [11, 11],
        [7, 7],
      ];
      return stars;
    }

    const edge = Math.max(3, Math.round((BOARD_SIZE - 1) / 4));
    const far = BOARD_SIZE - 1 - edge;
    const center = Math.floor((BOARD_SIZE - 1) / 2);
    const points: Array<readonly [number, number]> = [
      [edge, edge],
      [edge, far],
      [far, edge],
      [far, far],
    ];
    if (center !== edge && center !== far) points.push([center, center]);
    return points;
  }

  class Renderer {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly cell: number;
    private readonly padding: number;
    private readonly size: number;
    private hover: Move | null = null;

    constructor(canvas: HTMLCanvasElement, cellSize = 24) {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器不支持 canvas 2d');

      this.canvas = canvas;
      this.ctx = context;
      this.cell = cellSize;
      this.padding = this.cell * 0.9;
      this.size = this.padding * 2 + this.cell * (BOARD_SIZE - 1);

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(this.size * dpr);
      canvas.height = Math.round(this.size * dpr);
      canvas.style.width = `${this.size}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setHover(move: Move | null): void {
      this.hover = move;
    }

    /** 鼠标/手指坐标 → 最近的交叉点 */
    toBoardPoint(clientX: number, clientY: number): Move | null {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0) return null;

      const scale = rect.width / this.size;
      const x = (clientX - rect.left) / scale;
      const y = (clientY - rect.top) / scale;

      const col = Math.round((x - this.padding) / this.cell);
      const row = Math.round((y - this.padding) / this.cell);
      if (!inBounds(row, col)) return null;

      return { row, col };
    }

    draw(state: RenderState): void {
      const ctx = this.ctx;
      const cell = this.cell;
      const padding = this.padding;
      const last = BOARD_SIZE - 1;

      ctx.clearRect(0, 0, this.size, this.size);

      ctx.fillStyle = COLORS.board;
      ctx.fillRect(0, 0, this.size, this.size);
      ctx.strokeStyle = COLORS.boardEdge;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, this.size - 2, this.size - 2);

      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const end = padding + last * cell;
      for (let i = 0; i < BOARD_SIZE; i += 1) {
        const offset = padding + i * cell;
        ctx.moveTo(padding, offset);
        ctx.lineTo(end, offset);
        ctx.moveTo(offset, padding);
        ctx.lineTo(offset, end);
      }
      ctx.stroke();

      // 星位
      ctx.fillStyle = COLORS.line;
      const starRadius = Math.max(2, cell * 0.09);
      for (const [r, c] of starPoints()) {
        ctx.beginPath();
        ctx.arc(padding + c * cell, padding + r * cell, starRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // 冻结区：先画在棋子下面，棋子会自然盖住冻结标记
      if (state.frozen) {
        for (let i = 0; i < state.frozen.length; i += 1) {
          if (!state.frozen[i]) continue;

          const row = Math.floor(i / BOARD_SIZE);
          const col = i % BOARD_SIZE;
          const x = padding + col * cell;
          const y = padding + row * cell;

          ctx.beginPath();
          ctx.arc(x, y, cell * 0.38, 0, Math.PI * 2);
          ctx.fillStyle = COLORS.frozen;
          ctx.fill();
          ctx.strokeStyle = COLORS.frozenEdge;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // 落子预览（冻结区和已有棋子上不显示）
      if (this.hover && !state.isOver) {
        const hoverIndex = cellIndex(this.hover.row, this.hover.col);
        if (
          state.board[hoverIndex] === Stone.Empty &&
          (!state.frozen || !state.frozen[hoverIndex])
        ) {
          ctx.fillStyle = COLORS.hint;
          ctx.beginPath();
          ctx.arc(
            padding + this.hover.col * cell,
            padding + this.hover.row * cell,
            cell * 0.36,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }

      const radius = cell * 0.44;
      for (let i = 0; i < state.board.length; i += 1) {
        const stone = state.board[i];
        if (stone === Stone.Empty) continue;

        const row = Math.floor(i / BOARD_SIZE);
        const col = i % BOARD_SIZE;
        this.drawStone(padding + col * cell, padding + row * cell, radius, stone);
      }

      if (state.lastMove) {
        ctx.strokeStyle = COLORS.lastMove;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(
          padding + state.lastMove.col * cell,
          padding + state.lastMove.row * cell,
          radius * 0.45,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }

      // 获胜连线已经移除：用金线和金色空心圈标出被移除的全部点位
      if (state.winningLine.length > 0) {
        const first = state.winningLine[0];
        const lastStone = state.winningLine[state.winningLine.length - 1];
        ctx.strokeStyle = COLORS.winLine;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(padding + first.col * cell, padding + first.row * cell);
        ctx.lineTo(padding + lastStone.col * cell, padding + lastStone.row * cell);
        ctx.stroke();

        ctx.lineWidth = 2;
        for (const cellPoint of state.winningLine) {
          ctx.beginPath();
          ctx.arc(
            padding + cellPoint.col * cell,
            padding + cellPoint.row * cell,
            radius * 0.9,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      }
    }

    private drawStone(x: number, y: number, radius: number, stone: Player): void {
      const ctx = this.ctx;

      ctx.beginPath();
      ctx.arc(x, y + 1.5, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fill();

      const gradient = ctx.createRadialGradient(
        x - radius * 0.35,
        y - radius * 0.35,
        radius * 0.15,
        x,
        y,
        radius,
      );
      if (stone === Stone.Black) {
        gradient.addColorStop(0, '#6b6b74');
        gradient.addColorStop(1, COLORS.black);
      } else {
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#cfcfc9');
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = stone === Stone.Black ? '#0d0d10' : '#a9a9a2';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /* ------------------------------ 界面接线 ------------------------------ */

  interface Level {
    depth: number;
    width: number;
    timeBudgetMs: number;
  }

  const LEVELS: Record<string, Level> = {
    easy: { depth: 2, width: 10, timeBudgetMs: 600 },
    normal: { depth: 3, width: 10, timeBudgetMs: 1000 },
    hard: { depth: 4, width: 8, timeBudgetMs: 1500 },
  };

  function getElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`页面缺少 #${id} 元素，请确认 index.html 与本文件配套`);
    return element as T;
  }

  function statusText(game: Game): string {
    if (game.isMatchOver()) {
      if (game.matchWinner !== null) {
        return `${stoneName(game.matchWinner)}以 ${game.scoreOf(game.matchWinner)} 分赢得整场比赛！`;
      }
      if (game.finished === 'draw') {
        return '本局和棋，棋盘已无可用位置，整场和棋';
      }
      return '棋盘已无可用位置，整场和棋';
    }

    if (game.finished === 'black-win' || game.finished === 'white-win') {
      const winner = game.finished === 'black-win' ? Stone.Black : Stone.White;
      return `${stoneName(winner)}五连，本局得 1 分！`;
    }

    if (game.finished === 'draw') {
      return '本局和棋，双方不得分';
    }

    if (game.freezeMovesLeft > 0) {
      return `轮到${stoneName(game.current)} · 冻结中（剩 ${game.freezeMovesLeft} 步）`;
    }

    return `轮到${stoneName(game.current)}`;
  }

  function boot(): void {
    const canvas = getElement<HTMLCanvasElement>('board');
    const statusEl = getElement<HTMLElement>('status');
    const scoreEl = getElement<HTMLElement>('score');
    const roundEl = getElement<HTMLElement>('round');
    const stepsEl = getElement<HTMLElement>('steps');
    const undoButton = getElement<HTMLButtonElement>('undo');
    const nextButton = getElement<HTMLButtonElement>('next');
    const restartButton = getElement<HTMLButtonElement>('restart');
    const difficultySelect = getElement<HTMLSelectElement>('difficulty');
    const firstSelect = getElement<HTMLSelectElement>('first');

    const game = new Game();
    const renderer = new Renderer(canvas, 24);

    let humanColor: Player = firstSelect.value === 'ai' ? Stone.White : Stone.Black;
    let aiColor: Player = firstSelect.value === 'ai' ? Stone.Black : Stone.White;
    let thinking = false;
    let hover: Move | null = null;
    // 重新开始时让旧的 AI 定时器失效，避免它落在新棋盘上
    let generation = 0;

    const aiOptions = (): AiOptions => {
      const level = LEVELS[difficultySelect.value] || LEVELS.normal;
      return { depth: level.depth, width: level.width, timeBudgetMs: level.timeBudgetMs };
    };

    const render = (): void => {
      const roundOver = game.isRoundOver();
      const canHover = !game.isOver() && game.current === humanColor;
      renderer.setHover(canHover ? hover : null);

      renderer.draw({
        board: game.board,
        lastMove: roundOver ? null : game.lastMove(),
        winningLine: game.winLine,
        frozen: game.frozen,
        isOver: game.isOver(),
      });

      statusEl.textContent = thinking ? '电脑思考中…' : statusText(game);
      statusEl.setAttribute(
        'data-state',
        game.isOver() ? 'over' : game.current === humanColor ? 'you' : 'ai',
      );
      scoreEl.textContent = `黑 ${game.scores.black} : ${game.scores.white} 白`;
      roundEl.textContent = `第 ${game.round} 局`;
      stepsEl.textContent = `本局第 ${game.history.length} 手`;
      undoButton.disabled = thinking || !game.canUndo();
      nextButton.hidden = !roundOver || game.isMatchOver();
      nextButton.textContent = `开始第 ${game.round + 1} 局`;
    };

    const scheduleAi = (): void => {
      if (thinking || game.isOver() || game.current !== aiColor) return;

      thinking = true;
      render();

      const currentGeneration = generation;

      // 先让浏览器把「思考中」画出来，再做同步搜索
      window.setTimeout(() => {
        if (currentGeneration !== generation) return;

        const level = aiOptions();
        const move = findBestMove(game.board, aiColor, {
          depth: level.depth,
          width: level.width,
          timeBudgetMs: level.timeBudgetMs,
          frozen: game.frozen,
        });
        thinking = false;

        if (move && game.play(move)) {
          render();
          if (!game.isOver() && game.current === aiColor) scheduleAi();
          return;
        }

        render();
      }, 120);
    };

    const playHuman = (move: Move): void => {
      if (thinking || game.isOver() || game.current !== humanColor) return;
      if (!game.canPlay(move)) return;

      game.play(move);
      render();
      scheduleAi();
    };

    /** 悔棋：退到重新轮到自己，并且至少撤掉自己最近的一手（不跨局） */
    const undo = (): void => {
      if (thinking || !game.canUndo()) return;

      game.undo(1);
      while (game.history.length > 0 && !game.isOver() && game.current !== humanColor) {
        game.undo(1);
      }

      hover = null;
      render();
      scheduleAi();
    };

    const nextRound = (): void => {
      if (thinking || !game.isRoundOver() || game.isMatchOver()) return;

      game.startNextRound();
      hover = null;
      render();
      scheduleAi();
    };

    const newGame = (): void => {
      const aiFirst = firstSelect.value === 'ai';

      generation += 1;
      humanColor = aiFirst ? Stone.White : Stone.Black;
      aiColor = aiFirst ? Stone.Black : Stone.White;
      thinking = false;
      hover = null;

      game.reset();
      render();
      scheduleAi();
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const move = renderer.toBoardPoint(event.clientX, event.clientY);
      if (move) playHuman(move);
    });

    canvas.addEventListener('pointermove', (event) => {
      const move = renderer.toBoardPoint(event.clientX, event.clientY);
      const next = move && game.canPlay(move) ? move : null;

      const same = next && hover && next.row === hover.row && next.col === hover.col;
      if (same || (!next && !hover)) return;

      hover = next;
      render();
    });

    canvas.addEventListener('pointerleave', () => {
      if (!hover) return;
      hover = null;
      render();
    });

    undoButton.addEventListener('click', undo);
    nextButton.addEventListener('click', nextRound);
    restartButton.addEventListener('click', newGame);
    firstSelect.addEventListener('change', newGame);
    difficultySelect.addEventListener('change', render);

    // 调试用：控制台里 __gomoku.game 可以直接看棋局
    (window as unknown as Record<string, unknown>).__gomoku = {
      game,
      findBestMove,
      findWinningLine,
      buildFreezeZones,
      BOARD_SIZE,
    };

    render();
    scheduleAi();
  }

  /* ------------------------------- 启动 ------------------------------- */

  try {
    boot();
  } catch (error) {
    const status = document.getElementById('status');
    if (status) {
      status.textContent = `启动失败：${error instanceof Error ? error.message : String(error)}`;
    }
    console.error(error);
  }
})();

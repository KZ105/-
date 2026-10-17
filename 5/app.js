/* ==========================================================================
 * 五子棋 · 免构建版（纯 JavaScript）· 跨局冻结规则
 *
 * 直接双击 index.html 就能玩：
 *   - 不需要 npm install
 *   - 不需要打包 / tsc
 *   - 不需要启动本地服务器
 *
 * 结构与 TypeScript 版一一对应：
 *   常量 → 规则 → Game（纯逻辑）→ AI → Renderer（canvas）→ 界面接线
 *
 * 自创规则：
 *   - 30×30 棋盘，五局三胜（先得 3 分者赢得整场）
 *   - 每局五连得 1 分，本局立即结束；棋盘跨局保留，不清空
 *   - 获胜连线立即从棋盘移除：恰好五连移除五颗，六连及以上移除整条连续棋子
 *   - 每局结束后，用“剩余棋子”生成下一局的冻结区域：
 *     每颗棋子自身及周围 3×3 全部冻结
 *   - 下一局开始后随机 5–15 手内解除冻结；解除前不能落在冻结区
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------- 常量 ------------------------------- */

  var BOARD_SIZE = 30;
  var WIN_LENGTH = 5;
  var WIN_SCORE = 3;
  var FREEZE_MIN_STEPS = 5;
  var FREEZE_MAX_STEPS = 15;

  var Stone = { Empty: 0, Black: 1, White: 2 };

  /** 横、竖、主对角、副对角 */
  var DIRECTIONS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];

  function opponent(player) {
    return player === Stone.Black ? Stone.White : Stone.Black;
  }

  function stoneName(stone) {
    if (stone === Stone.Black) return '黑棋';
    if (stone === Stone.White) return '白棋';
    return '空';
  }

  function inBounds(row, col) {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
  }

  function cellIndex(row, col) {
    return row * BOARD_SIZE + col;
  }

  /** [min, max] 闭区间内的随机整数 */
  function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function emptyBoard() {
    return new Array(BOARD_SIZE * BOARD_SIZE).fill(Stone.Empty);
  }

  function emptyFlags() {
    return new Array(BOARD_SIZE * BOARD_SIZE).fill(false);
  }

  function hasAnyFlag(flags) {
    for (var i = 0; i < flags.length; i += 1) {
      if (flags[i]) return true;
    }
    return false;
  }

  /**
   * 冻结区域：以每颗仍然存在的棋子为中心的 3×3。
   * 已经被移除的获胜连线不在棋盘上，因此不会产生冻结区域。
   */
  function buildFreezeZones(board) {
    var frozen = emptyFlags();

    for (var i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty) continue;

      var row = (i / BOARD_SIZE) | 0;
      var col = i % BOARD_SIZE;

      for (var dr = -1; dr <= 1; dr += 1) {
        for (var dc = -1; dc <= 1; dc += 1) {
          var r = row + dr;
          var c = col + dc;
          if (inBounds(r, c)) frozen[cellIndex(r, c)] = true;
        }
      }
    }

    return frozen;
  }

  /** 是否还有“空且未冻结”的位置可以落子 */
  function hasLegalMove(board, frozen) {
    for (var i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty && !frozen[i]) return true;
    }
    return false;
  }

  /* ------------------------------- 规则 ------------------------------- */

  /** 判断这一手是否凑成五连（双向计数，长连也算胜） */
  function isWinningMove(board, move, player) {
    var row = move.row;
    var col = move.col;
    if (board[cellIndex(row, col)] !== player) return false;

    for (var d = 0; d < DIRECTIONS.length; d += 1) {
      var dr = DIRECTIONS[d][0];
      var dc = DIRECTIONS[d][1];
      var count = 1;

      for (var s = 0; s < 2; s += 1) {
        var sign = s === 0 ? 1 : -1;
        var r = row + dr * sign;
        var c = col + dc * sign;
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
  function findWinningLine(board, move, player) {
    var row = move.row;
    var col = move.col;
    if (board[cellIndex(row, col)] !== player) return [];

    var bestLine = [];

    for (var d = 0; d < DIRECTIONS.length; d += 1) {
      var dr = DIRECTIONS[d][0];
      var dc = DIRECTIONS[d][1];
      var line = [{ row: row, col: col }];

      for (var s = 0; s < 2; s += 1) {
        var sign = s === 0 ? 1 : -1;
        var r = row + dr * sign;
        var c = col + dc * sign;
        while (inBounds(r, c) && board[cellIndex(r, c)] === player) {
          line.push({ row: r, col: c });
          r += dr * sign;
          c += dc * sign;
        }
      }

      if (line.length >= WIN_LENGTH && line.length > bestLine.length) {
        line.sort(function (a, b) {
          return a.row - b.row || a.col - b.col;
        });
        bestLine = line;
      }
    }

    return bestLine;
  }

  /* ------------------------------- 对局 ------------------------------- */

  /**
   * 纯逻辑的对局状态：棋盘、落子历史、悔棋、比分、跨局冻结。
   * 不认识 canvas，也不认识 AI。
   */
  function Game() {
    this.board = emptyBoard();
    this.history = [];
    this.current = Stone.Black;
    this.finished = 'playing'; // 'playing' | 'black-win' | 'white-win' | 'draw'
    this.winLine = [];

    /** 整场比分与局数 */
    this.scores = { black: 0, white: 0 };
    this.round = 1;
    this.matchOver = false;
    this.matchWinner = null;

    /** 本局当前生效的冻结区；到达随机解除步数后清空 */
    this.frozen = emptyFlags();
    /** 本局开始时固定的冻结区，悔棋时用来恢复 */
    this.roundFrozen = emptyFlags();
    /** 本局随机抽取的冻结解除步数（5–15；0 表示本局没有冻结区） */
    this.freezeReleaseMove = 0;
    /** 距离解冻还剩多少手（0 表示已解冻或本局没有冻结区） */
    this.freezeMovesLeft = 0;

    /** 本局结束前最后一手的完整快照，用于撤销制胜手/和棋手 */
    this.roundEndSnapshot = null;
  }

  Game.prototype.at = function (row, col) {
    return this.board[cellIndex(row, col)];
  };

  Game.prototype.isOver = function () {
    return this.finished !== 'playing' || this.matchOver;
  };

  Game.prototype.isRoundOver = function () {
    return this.finished !== 'playing';
  };

  Game.prototype.isMatchOver = function () {
    return this.matchOver;
  };

  Game.prototype.lastMove = function () {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  };

  Game.prototype.scoreOf = function (player) {
    return player === Stone.Black ? this.scores.black : this.scores.white;
  };

  /** 完整状态快照（悔棋用） */
  Game.prototype.snapshot = function () {
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
      freezeMovesLeft: this.freezeMovesLeft
    };
  };

  Game.prototype.restore = function (snapshot) {
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
  };

  Game.prototype.canUndo = function () {
    if (this.roundEndSnapshot) return true;
    return !this.isOver() && this.history.length > 0;
  };

  Game.prototype.canPlay = function (move) {
    if (this.isOver()) return false;
    if (!inBounds(move.row, move.col)) return false;
    var index = cellIndex(move.row, move.col);
    return this.board[index] === Stone.Empty && !this.frozen[index];
  };

  /**
   * 本局结束：记分、移除获胜连线、根据剩余棋子生成下一局冻结区。
   * 如果下一局已经没有任何可落子的位置，则整场和棋。
   */
  Game.prototype.finishRound = function (result, winner, winningLine) {
    this.finished = result;
    this.winLine = winningLine;

    if (winner !== null) {
      var side = winner === Stone.Black ? 'black' : 'white';
      this.scores[side] += 1;
      if (this.scores[side] >= WIN_SCORE) {
        this.matchOver = true;
        this.matchWinner = winner;
      }
    }

    // 先移除获胜连线（五连或更长），再用“仍然存在”的棋子生成冻结区。
    for (var i = 0; i < winningLine.length; i += 1) {
      var cell = winningLine[i];
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
  };

  /** 落子；非法则返回 false */
  Game.prototype.play = function (move) {
    if (!this.canPlay(move)) return false;

    var before = this.snapshot();
    var player = this.current;
    var index = cellIndex(move.row, move.col);
    this.board[index] = player;
    this.history.push({ row: move.row, col: move.col });

    var winningLine = findWinningLine(this.board, move, player);
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
  };

  /** 开始下一局：棋盘和比分保留，只重置本局落子记录与冻结倒计时 */
  Game.prototype.startNextRound = function () {
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
  };

  /** 悔棋 steps 手（可以撤销本局最后一手，包括制胜手/和棋手） */
  Game.prototype.undo = function (steps) {
    if (this.isOver()) {
      if (!this.roundEndSnapshot) return false;
      var snapshot = this.roundEndSnapshot;
      this.roundEndSnapshot = null;
      this.restore(snapshot);
      return true;
    }

    var count = typeof steps === 'number' && steps > 0 ? steps : 1;
    var undone = false;

    for (var i = 0; i < count && this.history.length > 0; i += 1) {
      var last = this.history.pop();
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
  };

  Game.prototype.reset = function () {
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
  };

  /* -------------------------------- AI -------------------------------- */

  /** 各棋型的权重 */
  var SHAPE = {
    five: 10000000, // 成五
    openFour: 400000, // 活四
    four: 40000, // 冲四
    openThree: 20000, // 活三
    three: 2000, // 眠三
    openTwo: 1500, // 活二
    two: 200, // 眠二
    one: 20 // 单子
  };

  /** 进攻略微优先于防守 */
  var ATTACK_BIAS = 1.15;

  function at(board, row, col) {
    if (!inBounds(row, col)) return Stone.Empty;
    return board[cellIndex(row, col)];
  }

  /**
   * 单方向形状分：假设 (row,col) 已经是 player 的子，
   * 数一下这个方向上连了几颗、两端开口情况如何。
   */
  function shapeScore(board, row, col, player) {
    var best = 0;

    for (var d = 0; d < DIRECTIONS.length; d += 1) {
      var dr = DIRECTIONS[d][0];
      var dc = DIRECTIONS[d][1];
      var count = 1;
      var openEnds = 0;
      var jump = 0; // 连子尽头隔一格还有自己的子（●●_● 这类）

      for (var s = 0; s < 2; s += 1) {
        var sign = s === 0 ? 1 : -1;
        var r = row + dr * sign;
        var c = col + dc * sign;

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

      var score;
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

      // 隔一格还能接上，整体提升一档
      if (jump > 0 && count < WIN_LENGTH) score *= 2;

      if (score > best) best = score;
    }

    return best;
  }

  /** 在这个点落子的价值：自己进攻 + 顺便封堵对手 */
  function moveScore(board, move, me) {
    var index = cellIndex(move.row, move.col);
    var previous = board[index];
    var them = opponent(me);

    board[index] = me;
    var attack = shapeScore(board, move.row, move.col, me);

    board[index] = them;
    var block = shapeScore(board, move.row, move.col, them);

    board[index] = previous;
    return attack * ATTACK_BIAS + block;
  }

  /** 全盘评估：我方总分 - 对方总分 */
  function evaluate(board, me) {
    var them = opponent(me);
    var mine = 0;
    var theirs = 0;

    for (var i = 0; i < board.length; i += 1) {
      var stone = board[i];
      if (stone === Stone.Empty) continue;

      var row = (i / BOARD_SIZE) | 0;
      var col = i % BOARD_SIZE;
      if (stone === me) mine += shapeScore(board, row, col, me) / 5;
      else theirs += shapeScore(board, row, col, them) / 5;
    }

    return mine - theirs * 1.1;
  }

  /** 所有“已有棋子附近 radius 格”内、且未冻结的空位，AI 只在这些点里挑 */
  function nearbyCells(board, radius, frozen) {
    var seen = Object.create(null);
    var result = [];

    for (var i = 0; i < board.length; i += 1) {
      if (board[i] === Stone.Empty) continue;

      var baseRow = (i / BOARD_SIZE) | 0;
      var baseCol = i % BOARD_SIZE;

      for (var dr = -radius; dr <= radius; dr += 1) {
        for (var dc = -radius; dc <= radius; dc += 1) {
          var r = baseRow + dr;
          var c = baseCol + dc;
          if (!inBounds(r, c)) continue;

          var index = cellIndex(r, c);
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
  function allLegalCells(board, frozen) {
    var result = [];
    for (var i = 0; i < board.length; i += 1) {
      if (board[i] !== Stone.Empty) continue;
      if (frozen && frozen[i]) continue;

      result.push({ row: (i / BOARD_SIZE) | 0, col: i % BOARD_SIZE });
    }
    return result;
  }

  /**
   * 候选点按价值排序后截取前 width 个。
   * 冻结开局时棋子附近可能全是冻结区，此时退化为全盘合法空位，
   * 并用轻微的中心偏好打破形状分相同的平局。
   */
  function orderedMoves(board, me, width, frozen) {
    var cells = nearbyCells(board, 2, frozen);
    var usedFallback = false;

    if (cells.length === 0) {
      cells = allLegalCells(board, frozen);
      usedFallback = true;
    }

    if (cells.length === 0) return [];

    var centerCoord = (BOARD_SIZE - 1) / 2;
    var scored = [];

    for (var i = 0; i < cells.length; i += 1) {
      var move = cells[i];
      var score = moveScore(board, move, me);
      if (usedFallback) {
        var distance = Math.abs(move.row - centerCoord) + Math.abs(move.col - centerCoord);
        score += (BOARD_SIZE * 2 - distance) * 0.01;
      }
      scored.push({ move: move, score: score });
    }

    scored.sort(function (a, b) {
      return b.score - a.score;
    });

    var result = [];
    for (var j = 0; j < scored.length && j < width; j += 1) {
      result.push(scored[j].move);
    }
    return result;
  }

  /** player 现在就能成五的点 */
  function immediateWins(board, player, frozen, limit) {
    var max = typeof limit === 'number' ? limit : 4;
    var cells = nearbyCells(board, 2, frozen);
    if (cells.length === 0) cells = allLegalCells(board, frozen);

    var wins = [];

    for (var i = 0; i < cells.length; i += 1) {
      var move = cells[i];
      var index = cellIndex(move.row, move.col);

      board[index] = player;
      var win = isWinningMove(board, move, player);
      board[index] = Stone.Empty;

      if (win) {
        wins.push(move);
        if (wins.length >= max) break;
      }
    }

    return wins;
  }

  function negamax(board, depth, alpha, beta, player, ctx) {
    ctx.nodes += 1;

    if ((ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) {
      ctx.aborted = true;
      return evaluate(board, ctx.me);
    }

    if (depth === 0) {
      return player === ctx.me ? evaluate(board, ctx.me) : -evaluate(board, ctx.me);
    }

    var moves = orderedMoves(board, player, depth >= 3 ? 8 : 10, ctx.frozen);
    if (moves.length === 0) return 0;

    var maximizing = player === ctx.me;
    var best = maximizing ? -Infinity : Infinity;

    for (var i = 0; i < moves.length; i += 1) {
      var move = moves[i];
      var index = cellIndex(move.row, move.col);
      board[index] = player;

      var value;
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
   * 选点顺序：我能成五 → 堵对手成五 → 活四 → 堵冲四 → α-β 搜索。
   * 传入的棋盘不会被改动（内部先复制一份）。
   */
  function findBestMove(board, me, options) {
    var opts = options || {};
    var depth = typeof opts.depth === 'number' ? opts.depth : 3;
    var width = typeof opts.width === 'number' ? opts.width : 10;
    var timeBudgetMs = typeof opts.timeBudgetMs === 'number' ? opts.timeBudgetMs : 1000;
    var frozen = opts.frozen !== undefined ? opts.frozen : null;

    var work = board.slice();

    var wins = immediateWins(work, me, frozen);
    if (wins.length > 0) return wins[0];

    var blocks = immediateWins(work, opponent(me), frozen);
    if (blocks.length > 0) return blocks[0];

    var ctx = {
      me: me,
      deadline: Date.now() + timeBudgetMs,
      nodes: 0,
      aborted: false,
      frozen: frozen
    };

    var rootMoves = orderedMoves(work, me, width, frozen);
    if (rootMoves.length === 0) return null;

    var best = rootMoves[0];
    var bestValue = -Infinity;

    for (var i = 0; i < rootMoves.length; i += 1) {
      var move = rootMoves[i];
      var index = cellIndex(move.row, move.col);
      work[index] = me;

      var value;
      if (isWinningMove(work, move, me)) {
        value = 10000000;
      } else {
        value = negamax(work, depth - 1, -Infinity, Infinity, opponent(me), ctx);
      }

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

  var COLORS = {
    board: '#e3b673',
    boardEdge: '#c8964f',
    line: '#7a5326',
    black: '#1c1c20',
    lastMove: '#e03b3b',
    winLine: '#ffcf33',
    hint: 'rgba(30, 110, 220, 0.35)',
    frozen: 'rgba(86, 156, 214, 0.24)',
    frozenEdge: 'rgba(60, 130, 200, 0.38)'
  };

  /** 星位随棋盘大小生成；30×30 用四角 + 中心 */
  function starPoints() {
    if (BOARD_SIZE === 15) {
      return [
        [3, 3],
        [3, 11],
        [11, 3],
        [11, 11],
        [7, 7]
      ];
    }

    var edge = Math.max(3, Math.round((BOARD_SIZE - 1) / 4));
    var far = BOARD_SIZE - 1 - edge;
    var center = Math.floor((BOARD_SIZE - 1) / 2);
    var points = [
      [edge, edge],
      [edge, far],
      [far, edge],
      [far, far]
    ];
    if (center !== edge && center !== far) points.push([center, center]);
    return points;
  }

  function Renderer(canvas, cellSize) {
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 canvas 2d');

    this.canvas = canvas;
    this.ctx = ctx;
    this.cell = cellSize || 24;
    this.padding = this.cell * 0.9;
    this.size = this.padding * 2 + this.cell * (BOARD_SIZE - 1);
    this.hover = null;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(this.size * dpr);
    canvas.height = Math.round(this.size * dpr);
    // 只设置 CSS 宽度，高度交给 CSS 的 height:auto 按原始比例缩放
    canvas.style.width = this.size + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  Renderer.prototype.setHover = function (move) {
    this.hover = move;
  };

  /** 鼠标/手指坐标 → 最近的交叉点 */
  Renderer.prototype.toBoardPoint = function (clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return null;

    // 画布可能被 CSS 缩小过，这里换算回绘制坐标
    var scale = rect.width / this.size;
    var x = (clientX - rect.left) / scale;
    var y = (clientY - rect.top) / scale;

    var col = Math.round((x - this.padding) / this.cell);
    var row = Math.round((y - this.padding) / this.cell);
    if (!inBounds(row, col)) return null;

    return { row: row, col: col };
  };

  Renderer.prototype.draw = function (state) {
    var ctx = this.ctx;
    var cell = this.cell;
    var padding = this.padding;
    var last = BOARD_SIZE - 1;

    ctx.clearRect(0, 0, this.size, this.size);

    // 木纹底色
    ctx.fillStyle = COLORS.board;
    ctx.fillRect(0, 0, this.size, this.size);
    ctx.strokeStyle = COLORS.boardEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.size - 2, this.size - 2);

    // 网格
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var end = padding + last * cell;
    for (var i = 0; i < BOARD_SIZE; i += 1) {
      var offset = padding + i * cell;
      ctx.moveTo(padding, offset);
      ctx.lineTo(end, offset);
      ctx.moveTo(offset, padding);
      ctx.lineTo(offset, end);
    }
    ctx.stroke();

    // 星位
    ctx.fillStyle = COLORS.line;
    var starRadius = Math.max(2, cell * 0.09);
    var stars = starPoints();
    for (var s = 0; s < stars.length; s += 1) {
      ctx.beginPath();
      ctx.arc(padding + stars[s][1] * cell, padding + stars[s][0] * cell, starRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 冻结区：先画在棋子下面，棋子会自然盖住冻结标记
    if (state.frozen) {
      for (var f = 0; f < state.frozen.length; f += 1) {
        if (!state.frozen[f]) continue;

        var frozenRow = (f / BOARD_SIZE) | 0;
        var frozenCol = f % BOARD_SIZE;
        var frozenX = padding + frozenCol * cell;
        var frozenY = padding + frozenRow * cell;

        ctx.beginPath();
        ctx.arc(frozenX, frozenY, cell * 0.38, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.frozen;
        ctx.fill();
        ctx.strokeStyle = COLORS.frozenEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 落子预览（冻结区和已有棋子上不显示）
    if (this.hover && !state.isOver) {
      var hoverIndex = cellIndex(this.hover.row, this.hover.col);
      if (state.board[hoverIndex] === Stone.Empty && (!state.frozen || !state.frozen[hoverIndex])) {
        ctx.fillStyle = COLORS.hint;
        ctx.beginPath();
        ctx.arc(
          padding + this.hover.col * cell,
          padding + this.hover.row * cell,
          cell * 0.36,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // 棋子
    var radius = cell * 0.44;
    for (var n = 0; n < state.board.length; n += 1) {
      var stone = state.board[n];
      if (stone === Stone.Empty) continue;
      var row = (n / BOARD_SIZE) | 0;
      var col = n % BOARD_SIZE;
      this.drawStone(padding + col * cell, padding + row * cell, radius, stone);
    }

    // 最后一手标记
    if (state.lastMove) {
      ctx.strokeStyle = COLORS.lastMove;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        padding + state.lastMove.col * cell,
        padding + state.lastMove.row * cell,
        radius * 0.45,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }

    // 获胜连线已经移除：用金线和金色空心圈标出被移除的全部点位
    if (state.winningLine && state.winningLine.length > 0) {
      var first = state.winningLine[0];
      var lastStone = state.winningLine[state.winningLine.length - 1];
      ctx.strokeStyle = COLORS.winLine;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(padding + first.col * cell, padding + first.row * cell);
      ctx.lineTo(padding + lastStone.col * cell, padding + lastStone.row * cell);
      ctx.stroke();

      ctx.lineWidth = 2;
      for (var w = 0; w < state.winningLine.length; w += 1) {
        var cellPoint = state.winningLine[w];
        ctx.beginPath();
        ctx.arc(
          padding + cellPoint.col * cell,
          padding + cellPoint.row * cell,
          radius * 0.9,
          0,
          Math.PI * 2
        );
        ctx.stroke();
      }
    }
  };

  Renderer.prototype.drawStone = function (x, y, radius, stone) {
    var ctx = this.ctx;

    // 阴影
    ctx.beginPath();
    ctx.arc(x, y + 1.5, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fill();

    // 径向渐变
    var gradient = ctx.createRadialGradient(
      x - radius * 0.35,
      y - radius * 0.35,
      radius * 0.15,
      x,
      y,
      radius
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
  };

  /* ------------------------------ 界面接线 ------------------------------ */

  var LEVELS = {
    easy: { depth: 2, width: 10, timeBudgetMs: 600 },
    normal: { depth: 3, width: 10, timeBudgetMs: 1000 },
    hard: { depth: 4, width: 8, timeBudgetMs: 1500 }
  };

  function statusText(game) {
    if (game.isMatchOver()) {
      if (game.matchWinner !== null) {
        return stoneName(game.matchWinner) + '以 ' + game.scoreOf(game.matchWinner) + ' 分赢得整场比赛！';
      }
      if (game.finished === 'draw') {
        return '本局和棋，棋盘已无可用位置，整场和棋';
      }
      return '棋盘已无可用位置，整场和棋';
    }

    if (game.finished === 'black-win' || game.finished === 'white-win') {
      var winner = game.finished === 'black-win' ? Stone.Black : Stone.White;
      return stoneName(winner) + '五连，本局得 1 分！';
    }

    if (game.finished === 'draw') {
      return '本局和棋，双方不得分';
    }

    if (game.freezeMovesLeft > 0) {
      return '轮到' + stoneName(game.current) + ' · 冻结中（剩 ' + game.freezeMovesLeft + ' 步）';
    }

    return '轮到' + stoneName(game.current);
  }

  function boot() {
    var canvas = document.getElementById('board');
    var statusEl = document.getElementById('status');
    var scoreEl = document.getElementById('score');
    var roundEl = document.getElementById('round');
    var stepsEl = document.getElementById('steps');
    var undoButton = document.getElementById('undo');
    var nextButton = document.getElementById('next');
    var restartButton = document.getElementById('restart');
    var difficultySelect = document.getElementById('difficulty');
    var firstSelect = document.getElementById('first');

    if (
      !canvas ||
      !statusEl ||
      !scoreEl ||
      !roundEl ||
      !stepsEl ||
      !undoButton ||
      !nextButton ||
      !restartButton ||
      !difficultySelect ||
      !firstSelect
    ) {
      throw new Error('页面元素不完整，请确认 index.html 与本文件配套');
    }

    var game = new Game();
    var renderer = new Renderer(canvas, 24);

    var humanColor = firstSelect.value === 'ai' ? Stone.White : Stone.Black;
    var aiColor = firstSelect.value === 'ai' ? Stone.Black : Stone.White;
    var thinking = false;
    var hover = null;
    // 重新开始时让旧的 AI 定时器失效，避免它落在新棋盘上
    var generation = 0;

    function aiOptions() {
      var level = LEVELS[difficultySelect.value] || LEVELS.normal;
      return {
        depth: level.depth,
        width: level.width,
        timeBudgetMs: level.timeBudgetMs
      };
    }

    function render() {
      var roundOver = game.isRoundOver();
      var canHover = !game.isOver() && game.current === humanColor;
      renderer.setHover(canHover ? hover : null);

      renderer.draw({
        board: game.board,
        lastMove: roundOver ? null : game.lastMove(),
        winningLine: game.winLine,
        frozen: game.frozen,
        isOver: game.isOver()
      });

      statusEl.textContent = thinking ? '电脑思考中…' : statusText(game);
      statusEl.setAttribute('data-state', game.isOver() ? 'over' : game.current === humanColor ? 'you' : 'ai');
      scoreEl.textContent = '黑 ' + game.scores.black + ' : ' + game.scores.white + ' 白';
      roundEl.textContent = '第 ' + game.round + ' 局';
      stepsEl.textContent = '本局第 ' + game.history.length + ' 手';
      undoButton.disabled = thinking || !game.canUndo();
      nextButton.hidden = !roundOver || game.isMatchOver();
      nextButton.textContent = '开始第 ' + (game.round + 1) + ' 局';
    }

    function scheduleAi() {
      if (thinking || game.isOver() || game.current !== aiColor) return;

      thinking = true;
      render();

      var currentGeneration = generation;

      // 先让浏览器把「思考中」画出来，再做同步搜索
      window.setTimeout(function () {
        if (currentGeneration !== generation) return;

        var level = aiOptions();
        var move = findBestMove(game.board, aiColor, {
          depth: level.depth,
          width: level.width,
          timeBudgetMs: level.timeBudgetMs,
          frozen: game.frozen
        });

        thinking = false;

        if (move && game.play(move)) {
          render();
          if (!game.isOver() && game.current === aiColor) scheduleAi();
          return;
        }

        render();
      }, 120);
    }

    function playHuman(move) {
      if (thinking || game.isOver() || game.current !== humanColor) return;
      if (!game.canPlay(move)) return;

      game.play(move);
      render();
      scheduleAi();
    }

    /** 悔棋：退到重新轮到自己，并且至少撤掉自己最近的一手（不跨局） */
    function undo() {
      if (thinking || !game.canUndo()) return;

      game.undo(1);
      while (game.history.length > 0 && !game.isOver() && game.current !== humanColor) {
        game.undo(1);
      }

      hover = null;
      render();
      scheduleAi();
    }

    function nextRound() {
      if (thinking || !game.isRoundOver() || game.isMatchOver()) return;

      game.startNextRound();
      hover = null;
      render();
      scheduleAi();
    }

    function newGame() {
      var aiFirst = firstSelect.value === 'ai';

      generation += 1;
      humanColor = aiFirst ? Stone.White : Stone.Black;
      aiColor = aiFirst ? Stone.Black : Stone.White;
      thinking = false;
      hover = null;

      game.reset();
      render();
      scheduleAi();
    }

    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      var move = renderer.toBoardPoint(event.clientX, event.clientY);
      if (move) playHuman(move);
    });

    canvas.addEventListener('pointermove', function (event) {
      var move = renderer.toBoardPoint(event.clientX, event.clientY);
      var next = move && game.canPlay(move) ? move : null;

      if (next === hover) return;

      var sameHover =
        next && hover && next.row === hover.row && next.col === hover.col;
      if (sameHover) return;

      hover = next;
      render();
    });

    canvas.addEventListener('pointerleave', function () {
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
    window.__gomoku = {
      game: game,
      findBestMove: findBestMove,
      findWinningLine: findWinningLine,
      buildFreezeZones: buildFreezeZones,
      BOARD_SIZE: BOARD_SIZE
    };

    render();
    scheduleAi();
  }

  /* ------------------------------- 启动 ------------------------------- */

  try {
    boot();
  } catch (error) {
    var status = document.getElementById('status');
    if (status) status.textContent = '启动失败：' + (error && error.message ? error.message : error);
    console.error(error);
  }
})();

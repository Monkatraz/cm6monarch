import { fixCase, MonarchBracket, findRules, createError, isFuzzyAction, isIAction, substituteMatches, log, isString, sanitize, IMonarchParserAction } from './monarch/monarchCommon'
import type { IRule, ILexer, FuzzyAction } from './monarch/monarchCommon'

// -- UTIL. FUNCTIONS

function safeRuleName(rule: IRule | null): string { return rule?.name ?? '(unknown)' }

/** Searches for a bracket in the 'brackets' attribute that matches the input. */
function findBracket(lexer: ILexer, matched: string) {
  if (!matched) {
    return null
  }
  matched = fixCase(lexer, matched)

  let brackets = lexer.brackets
  for (const bracket of brackets) {
    if (bracket.open === matched) {
      return { token: bracket.token, bracketType: MonarchBracket.Open }
    }
    else if (bracket.close === matched) {
      return { token: bracket.token, bracketType: MonarchBracket.Close }
    }
  }
  return null
}

// -- STACK



// It's important to know that the `line` mentioned here is an _offset_ from final line the nesting ended on.
export type MonarchEmbeddedLang = { lang: string, line: number, start: number, end: number }
export type MonarchStackEmbeddedLang = { lang: string, line: number, start: number }

// '[state].&lng=[lang]&ln=[ln-num]&strt=[offset]'
const EMBEDDED_LANG_REGEX = /.*?\.&lng=([^&]+?)&ln=([^&]+?)&strt=([^&]+?)$/

/** A mutable, shallow, and copyable `Array<string>` stack. */
export interface MonarchStack {
  /** The current state of the stack. */
  state: string
  /** The total depth of the stack. */
  depth: number
  /** The stack as it was before the current state. */
  parent: MonarchStack
  /** The currently embedded language in the stack, if present. */
  embedded: MonarchStackEmbeddedLang | null
  /** Embeds information about a nested language into the stack. */
  embed(lang: string, line: number, start: number): void
  /** Removes the embedded language from the stack. */
  popEmbedded(): void
  /** Adds an offset to the line of the embedded language. */
  offsetEmbedded(offset: number): void
  /** Returns a clone of the internal stack as an array of strings. */
  serialize(): string[]
  /** Returns a clone of the stack. */
  clone(): MonarchStack
  /** Adds a new state to the stack. */
  push(state: string): void
  /** Switches to a new state in the stack. */
  switchTo(state: string): void
  /** Removes the last state in the stack. */
  pop(): void
  /** Removes all states in the stack, except for the first. */
  popall(): void
}

// TODO: it's gotten too big and needs to be a class now

/** Creates a new `MonarchStack` object. */
export function createMonarchStack(start: string[]): MonarchStack {
  let stack: string[] = [...start] // clone

  // deserialize embedded
  const lst = stack.length - 1
  let embedded: MonarchStackEmbeddedLang | null = null
  if (EMBEDDED_LANG_REGEX.test(stack[lst])) {
    const matches = stack[lst].match(EMBEDDED_LANG_REGEX)
    if (matches) embedded = { lang: matches[0], line: parseInt(matches[1]), start: parseInt(matches[2]) }
    stack[lst] = stack[lst].replace(/\.&lng.*$/, '')
  }

  return {
    get state() { return stack[stack.length - 1] },
    get depth() { return stack.length },
    get parent() { const parent = this.clone(); parent.pop(); return parent },
    clone() { return createMonarchStack([...this.serialize()]) },
    push(state: string) { stack.push(state) },
    switchTo(state: string) { stack[stack.length - 1] = state },
    pop() { stack.pop() },
    popall() { stack = [stack.shift() ?? 'root'] },
    // embedded shenanigans
    get embedded() {
      // returns a clone
      return embedded ? { lang: embedded.lang, line: embedded.line, start: embedded.start } : null
    },
    embed(lang: string, line: number, start: number) { embedded = { lang, line, start } },
    popEmbedded() { embedded = null },
    offsetEmbedded(offset: number) { if (embedded) embedded.line += offset },
    // serializing
    serialize() {
      const embeddedStr = embedded ? `.&lng=${embedded.lang}&ln=${embedded.line}&strt=${embedded.start}` : ''
      const copyStack = [...stack]
      copyStack[copyStack.length - 1] += embeddedStr
      return copyStack
    }
  }
}

/** Compares two stacks and returns if they are equal.
 *  They can be pure `MonarchStack` objects or already serialized. */
export function stackIsEqual(stack1: string[] | MonarchStack, stack2: string[] | MonarchStack) {
  // convert to just string arrays
  if ('serialize' in stack1) stack1 = stack1.serialize()
  if ('serialize' in stack2) stack2 = stack2.serialize()
  // check lengths
  if (stack1.length !== stack2.length) return false
  // check for every value
  return stack1.every((str, idx) => str === (stack2 as string[])[idx])
}

// -- TOKENIZE

export interface MonarchToken {
  /** The type of the token. */
  type: string
  /** The position of the start of the token, relative to the line it's on. */
  start: number
  /** The position of the end of the token, relative to the line it's on. */
  end: number

  parser?: IMonarchParserAction
}

export interface TokenizeOpts {
  /** The line to be tokenized. */
  line: string
  /** The (already compiled) Monarch lexer configuration. */
  lexer: ILexer
  /** The `MonarchStack` that the tokenizer will begin with. */
  stack: MonarchStack
  /** The offset from the start of the line that the tokenizer will begin from. */
  offset?: number
}

/** Returns the tokens for the given line. Mutates the `opts.stack` `MonarchStack` object. */
export function tokenize(opts: TokenizeOpts) {

  const tokens: MonarchToken[] = []

  const line = opts.line
  const lineLength = line.length
  const stack = opts.stack
  const lexer = opts.lexer

  let isEmbedded = stack.embedded !== null ? true : false
  let poppedEmbedded: MonarchEmbeddedLang[] = []
  if (isEmbedded) stack.offsetEmbedded(1)

  let pos = opts.offset ?? 0

  interface GroupMatching {
    matches: string[]
    rule: IRule | null
    groups: { action: FuzzyAction; matched: string }[]
  }
  let groupMatching: GroupMatching | null = null

  let last: { stack: string[], token: MonarchToken } | undefined

  // See https://github.com/microsoft/monaco-editor/issues/1235
  // Evaluate rules at least once for an empty line
  let forceEvaluation = true

  while (forceEvaluation || pos < lineLength) {

    const pos0 = pos
    const stackLen0 = stack.depth
    const groupLen0 = groupMatching ? groupMatching.groups.length : 0
    const state = stack.state

    let matches: string[] = ['']
    let matched: string = ''
    let action: FuzzyAction | FuzzyAction[] | null = null
    let rule: IRule | null = null

    isEmbedded = stack.embedded !== null ? true : false

    // check if we need to process group matches first
    if (groupMatching) {
      matches = groupMatching.matches
      const groupEntry = groupMatching.groups.shift()!
      matched = groupEntry.matched
      action = groupEntry.action
      rule = groupMatching.rule

      // cleanup if necessary
      if (groupMatching.groups.length === 0) groupMatching = null

    } else {
      // otherwise we match on the token stream

      // nothing to do
      if (!forceEvaluation && pos >= lineLength) break

      forceEvaluation = false

      // get the rules for this state
      let rules: IRule[] | null = lexer.tokenizer[state]
      if (!rules) rules = findRules(lexer, state) // do parent matching
      // check again
      if (!rules) throw createError(lexer,
        'tokenizer state is not defined: ' + state)

      // try each rule until we match
      for (const rule of rules) {
        if (pos === 0 || !rule.matchOnlyAtLineStart) {
          // so something goofy here is the `.test` call and THEN a `.exec` call, which seems inefficient
          // however it seems that `.test` does something more optimized when checking
          // infact it's insanely faster to do a `.test` first and then only afterwards doing an `.exec`
          // oh also, all of these regexes are sticky now, so that's why the lastIndex is being manipulated
          // this allows look-behinds to work
          rule.regex.lastIndex = pos
          if (rule.regex.test(line)) {
            rule.regex.lastIndex = pos
            matches = rule.regex.exec(line)!
            matched = matches[0]
            action = rule.action
            break
          }
        }
      }
    }

    if (!action) {
      // bad: we didn't match anything, and there is no action to take
      // we need to advance the stream or we get progress trouble
      if (pos < lineLength) {
        matches = [line.charAt(pos)]
        matched = matches[0]
      }
      action = lexer.defaultToken
    }

    // advance stream
    pos += matched.length

    // maybe call action function (used for 'cases')
    while (isFuzzyAction(action) && isIAction(action) && action.test)
      action = action.test(matched, matches, state, pos === lineLength)

    let result: FuzzyAction | FuzzyAction[] | null = null
    // set the result: either a string or an array of actions
    if (typeof action === 'string' || Array.isArray(action)) result = action
    else if (action.group) result = action.group
    else if (action.token !== null && action.token !== undefined) {

      // do $n replacements?
      if (action.tokenSubst) result = substituteMatches(lexer, action.token, matched, matches, state)
      else result = action.token

      // state transformations

      if (action.nextEmbedded) {
        if (action.nextEmbedded === '@pop') {
          if (!isEmbedded) throw createError(lexer,
            'attempted to pop nested stack while not nesting any language in rule: ' + safeRuleName(rule))
          else {
            poppedEmbedded.push({ ...stack.embedded!, end: pos - matched.length })
            stack.popEmbedded()
            isEmbedded = false
          }
        }
        else {
          if (isEmbedded) throw createError(lexer,
            'attempted to nest more than one language in rule: ' + safeRuleName(rule))
          else {
            const embedded = substituteMatches(lexer, action.nextEmbedded, matched, matches, state)
            const start = action.token === '@rematch' ? pos - matched.length : pos
            stack.embed(embedded, 0, start)
            // we need to push a special token so that we can find our nesting node in the token stream
            tokens.push({
              type: '_NEST_',
              start: start,
              end: start
            })
          }
        }
      }

      // back up the stream..
      if (action.goBack) pos = Math.max(0, pos - action.goBack)

      if (action.switchTo) {
        // switch state without a push...
        let nextState = substituteMatches(lexer, action.switchTo, matched, matches, state)
        if (nextState[0] === '@') nextState = nextState.substr(1) // peel off starting '@'

        if (!findRules(lexer, nextState)) throw createError(lexer,
          'trying to switch to a state \'' + nextState + '\' that is undefined in rule: ' + safeRuleName(rule))
        else stack.switchTo(nextState)
      }

      else if (action.transform)
        throw createError(lexer, 'action.transform not supported')

      else if (action.next) {
        if (action.next === '@push') {
          if (stack.depth >= lexer.maxStack) throw createError(lexer,
            'maximum tokenizer stack size reached: [' + stack.state + ',' + stack.parent.state + ',...]')
          else stack.push(state)
        }

        else if (action.next === '@pop') {
          if (stack.depth <= 1) throw createError(lexer, 'trying to pop an empty stack in rule: ' + safeRuleName(rule))
          else stack.pop()
        }

        else if (action.next === '@popall') stack.popall()

        else {
          let nextState = substituteMatches(lexer, action.next, matched, matches, state)
          if (nextState[0] === '@') nextState = nextState.substr(1) // peel off starting '@'

          if (!findRules(lexer, nextState)) throw createError(lexer,
            'trying to set a next state \'' + nextState + '\' that is undefined in rule: ' + safeRuleName(rule))
          else stack.push(nextState)
        }
      }

      if (action.log)
        log(lexer, lexer.languageId + ': ' + substituteMatches(lexer, action.log, matched, matches, state))
    }

    if (result === null) throw createError(lexer,
      'lexer rule has no well-defined action in rule: ' + safeRuleName(rule))

    // is the result a group match?
    if (Array.isArray(result)) {

      if (groupMatching && groupMatching.groups.length > 0) throw createError(lexer,
        'groups cannot be nested: ' + safeRuleName(rule))

      if (matches.length !== result.length + 1) throw createError(lexer,
        'matched number of groups does not match the number of actions in rule: ' + safeRuleName(rule))

      let totalLen = 0
      for (let i = 1; i < matches.length; i++) totalLen += matches[i].length

      if (totalLen !== matched.length) throw createError(lexer,
        'with groups, all characters should be matched in consecutive groups in rule: ' + safeRuleName(rule))

      groupMatching = {
        rule: rule,
        matches: matches,
        groups: []
      }
      for (let i = 0; i < result.length; i++) {
        groupMatching.groups[i] = {
          action: result[i],
          matched: matches[i + 1]
        }
      }

      pos -= matched.length

      continue
    } else {
      // regular result

      if (result === '@rematch') {
        pos -= matched.length
        matched = ''
        matches = ['']
        result = ''
        // rematch but the token still needs to signal the parser
        if (!isEmbedded && action && typeof action !== 'string' && action.parser)
          tokens.push({ type: '', start: pos0, end: pos, parser: action.parser })
      }

      // check progress
      if (matched.length === 0) {
        if (lineLength === 0 || stackLen0 !== stack.depth || state !== stack.state || (!groupMatching ? 0 : groupMatching.groups.length) !== groupLen0)
          continue
        else throw createError(lexer,
          'no progress in tokenizer in rule: ' + safeRuleName(rule))
      }

      if (!isEmbedded) {
        // return the result (and check for brace matching)
        let tokenType: string | null = null
        if (isString(result) && result.indexOf('@brackets') === 0) {
          let rest = result.substr(9) // 9 = '@brackets`.length
          let bracket = findBracket(lexer, matched)

          if (!bracket) throw createError(lexer,
            '@brackets token returned but no bracket defined as: ' + matched)

          tokenType = sanitize(bracket.token + rest)
        }
        else tokenType = sanitize(result === '' ? '' : result.toString())

        if (!tokenType.startsWith('@')) {
          // checking if we can merge this token with the last one
          // it's a lot of checks
          if (
            !(typeof action !== 'string' && 'parser' in action) &&
            last && last.token &&
            !last.token.parser &&
            last.token.type === tokenType &&
            last.token.end === pos0 &&
            stackIsEqual(last.stack, stack)
          ) {
            tokens[tokens.length - 1].end = pos
          } else
            tokens.push({
              type: tokenType, start: pos0, end: pos,
              parser: typeof action !== 'string' ? action.parser : undefined
            })
        }
      }
    }
    last = { stack: stack.serialize(), token: tokens[tokens.length - 1] }
  }
  return { stack, tokens, poppedEmbedded }
}
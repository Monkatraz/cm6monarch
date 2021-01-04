import { findRules, isFuzzyAction, isIAction, substituteMatches, isString, sanitize, safeRuleName, findBracket } from './monarch/monarchCommon'
import type { IMonarchParserAction, IRule, ILexer, FuzzyAction } from './monarch/monarchCommon'

// -- STACK

export type MonarchEmbeddedRange = { lang: string, line: number, start: number, end: number }

// '[state].&lng=[lang]&ln=[ln-num]&strt=[offset]'
const EMBEDDED_LANG_REGEX = /.*?\.&lng=([^&]+?)&ln=([^&]+?)&strt=([^&]+?)$/

export class MonarchEmbeddedData {
  constructor (
    /** The language of the embedded data, e.g. 'javascript'. */
    public lang: string,
    /** The starting line number of the embedded data, usually used as a _relative offset_ from the end line. */
    public line: number,
    /** The stating offset from the beginning of the line. */
    public start: number
  ) { }

  /** Serializes the embedded data into a string that can be attached to the front of a state `string[]` array. */
  public serialize() {
    return `.&lng=${this.lang}&ln=${this.line}&strt=${this.start}`
  }

  /** Returns the embedded data with a provided, final end position. */
  public finalize(end: number): MonarchEmbeddedRange {
    return { lang: this.lang, line: this.line, start: this.start, end }
  }

  /** Increments the line number by one, and returns the new number. */
  public increment() {
    return this.line += 1
  }

  /** Returns a clone of the embedded data object. */
  public clone() {
    return new MonarchEmbeddedData(this.lang, this.line, this.start)
  }

  /** Removes serialized embedded data from a state string. */
  static remove(state: string) {
    return state.replace(/(?<=^.*?)\.&lng.*$/, '')
  }

  /** Parses, and returns, an embedded data object from a state. */
  static deserialize(state: string) {
    if (state && EMBEDDED_LANG_REGEX.test(state)) {
      const matches = state.match(EMBEDDED_LANG_REGEX)
      if (matches) return new MonarchEmbeddedData(matches[1], parseInt(matches[2]), parseInt(matches[3]))
    }
    return null
  }
}

/** The class used by Monarch to keep track of its internal state. */
export class MonarchStack {

  /** The internal `string[]` stack. */
  private stack: string[]

  /** The embedded data, if present. */
  public embedded: MonarchEmbeddedData | null = null
  /** The top-most state of the stack. */
  public get state() { return this.stack[this.stack.length - 1] }
  /** The length (depth), or number of stack nodes, in the stack. */
  public get depth() { return this.stack.length }
  /** The parent of the stack, i.e. the state of the stack if it were to be popped. */
  public get parent() { const parent = this.clone(); parent.pop(); return parent }

  constructor (serializedStack: string[]) {
    const { stack, embedded } = MonarchStack.deserialize(serializedStack)
    this.stack = stack
    this.embedded = embedded
  }

  /** Push a new state to the top of the stack. */
  public push(state: string) { this.stack.push(state) }

  /** Switch to a new state, replacing the current one. */
  public switchTo(state: string) { this.stack[this.stack.length - 1] = state }

  /** Remove the top-most state of the stack. */
  public pop() { return this.stack.pop() }

  /** Remove all states from the stack except the very first. */
  public popall() { this.stack = [this.stack.shift() ?? 'root'] }

  /** Returns a deep clone of the stack. */
  public clone() {
    const clone = new MonarchStack([...this.stack])
    if (this.embedded)
      clone.embedded = this.embedded.clone()
    return clone
  }

  /** Sets the embedded data. */
  public setEmbedded(lang: string, line: number, start: number) {
    this.embedded = new MonarchEmbeddedData(lang, line, start)
  }

  /** Removes the embedded data. */
  public endEmbedded() {
    const embedded = this.embedded
    this.embedded = null
    return embedded
  }

  /** Serializes the stack and embedded data into a list of strings. */
  public serialize() {
    const copy = [...this.stack]
    const embeddedString = this.embedded ? this.embedded.serialize() : ''
    if (embeddedString)
      copy[copy.length - 1] += embeddedString
    return copy
  }

  /** Deserializes the stack and embedded data from a list of strings. */
  static deserialize(stack: string[]) {
    stack = [...stack] // clone to prevent mutations

    // deserialize embedded data
    const last = stack.length - 1
    const embedded = MonarchEmbeddedData.deserialize(stack[last])
    if (embedded)
      stack[last] = MonarchEmbeddedData.remove(stack[last])

    return { stack, embedded }
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
  /** Directs the parser to manipulate the syntax tree using the provided information. */
  parser?: IMonarchParserAction
}

/** Determines whether the first token can be merged with the second. */
export function canContinueToken(lastToken?: MonarchToken, nextToken?: MonarchToken) {
  if (!lastToken || !nextToken) return false
  if (lastToken.parser || nextToken.parser) return false
  if (lastToken.type !== nextToken.type) return false
  if (lastToken.end !== nextToken.start) return false
  return true
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

  // list of embedded ranges found when tokenizing
  let poppedEmbedded: MonarchEmbeddedRange[] = []
  // since we (presumably) moved down a line, this increments the embedded data origin offset
  if (stack.embedded) stack.embedded.increment()

  let pos = opts.offset ?? 0

  interface GroupMatching {
    matches: string[]
    rule: IRule | null
    groups: { action: FuzzyAction; matched: string }[]
  }
  let groupMatching: GroupMatching | null = null

  let last: { stack: string[], token: MonarchToken } | undefined

  // evaluate rules at least once for an empty line
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

    let pushEmbedded = 0
    let isEmbedded = stack.embedded !== null ? true : false

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

      forceEvaluation = false

      // get the rules for this state
      let rules: IRule[] | null = lexer.tokenizer[state]
      if (!rules) rules = findRules(lexer, state) // do parent matching
      // check again
      if (!rules) throw new Error(
        'tokenizer state is not defined: ' + state)

      // so something goofy here is the `.test` call and THEN a `.exec` call, which seems inefficient
      // however it seems that `.test` does something more optimized when checking
      // infact it's insanely faster to do a `.test` first and then only afterwards doing an `.exec`
      // oh also, all of these regexes are sticky now, so that's why the lastIndex is being manipulated
      // this allows look-behinds to work

      // try each rule until we match
      for (const rule of rules) {
        rule.regex.lastIndex = pos
        if ((pos === 0 || !rule.matchOnlyAtLineStart) && rule.regex.test(line)) {
          rule.regex.lastIndex = pos
          matches = rule.regex.exec(line)!
          matched = matches[0]
          action = rule.action
          break
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

      // do $n replacements
      if (action.tokenSubst) result = substituteMatches(lexer, action.token, matched, matches, state)
      else result = action.token

      // state transformations

      // manipulate current embedded language
      if (action.nextEmbedded) {
        if (action.nextEmbedded === '@pop') {
          if (!isEmbedded) throw new Error(
            'attempted to pop nested stack while not nesting any language in rule: ' + safeRuleName(rule))
          const range = stack.embedded!.finalize(pos - matched.length)
          poppedEmbedded.push(range)
          stack.endEmbedded()
          isEmbedded = false
        } else {
          if (isEmbedded) throw new Error(
            'attempted to nest more than one language in rule: ' + safeRuleName(rule))
          const embedded = substituteMatches(lexer, action.nextEmbedded, matched, matches, state)
          const start = action.token === '@rematch' ? pos - matched.length : pos
          stack.setEmbedded(embedded, 0, start)
          pushEmbedded = start
        }
      }

      // move the input stream back the specified number of characters
      if (action.goBack) pos = Math.max(0, pos - action.goBack)

      // perform a custom evalulation that returns an action
      else if (action.transform) throw new Error('action.transform not supported')

      // replace the current state with the specified one
      if (action.switchTo) {
        let nextState = substituteMatches(lexer, action.switchTo, matched, matches, state)
        if (nextState[0] === '@') nextState = nextState.substr(1) // peel off starting '@'

        if (!findRules(lexer, nextState)) throw new Error(
          'trying to switch to a state \'' + nextState + '\' that is undefined in rule: ' + safeRuleName(rule))
        else stack.switchTo(nextState)
      }

      // manipulate the stack's next state
      else if (action.next) {
        // push the current state again to the top of the stack
        if (action.next === '@push') {
          if (stack.depth >= lexer.maxStack) throw new Error(
            'maximum tokenizer stack size reached: [' + stack.state + ',' + stack.parent.state + ',...]')
          else stack.push(state)
        }

        // remove top-most state
        else if (action.next === '@pop') {
          if (stack.depth <= 1) throw new Error('trying to pop an empty stack in rule: ' + safeRuleName(rule))
          else stack.pop()
        }

        // pop all states except the first
        else if (action.next === '@popall') stack.popall()

        // move to specified state
        else {
          let nextState = substituteMatches(lexer, action.next, matched, matches, state)
          if (nextState[0] === '@') nextState = nextState.substr(1) // peel off starting '@'

          if (!findRules(lexer, nextState)) throw new Error(
            'trying to set a next state \'' + nextState + '\' that is undefined in rule: ' + safeRuleName(rule))
          else stack.push(nextState)
        }
      }

      // print a message in the console when the rule is matched
      if (action.log)
        console.log('[monarch rule]: ' + substituteMatches(lexer, action.log, matched, matches, state))
    }

    // nothing came out of our rule even though it matched
    if (result === null) throw new Error(
      'lexer rule has no well-defined action in rule: ' + safeRuleName(rule))

    // group matching
    if (Array.isArray(result)) {

      // validate the group matching definition
      if (groupMatching && groupMatching.groups.length > 0) throw new Error(
        'groups cannot be nested: ' + safeRuleName(rule))
      if (matches.length !== result.length + 1) throw new Error(
        'matched number of groups does not match the number of actions in rule: ' + safeRuleName(rule))
      let totalLen = 0
      for (let i = 1; i < matches.length; i++) totalLen += matches[i].length
      if (totalLen !== matched.length) throw new Error(
        'with groups, all characters should be matched in consecutive groups in rule: ' + safeRuleName(rule))

      // restart the tokenizer with our group matching information

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
      // normal matching

      // TODO: cleanup this whole section with @rematch and the special embedded token

      // back up the input and restart the tokenizer with a new state
      if (result === '@rematch') {
        pos -= matched.length
        matched = ''
        matches = ['']
        result = ''
        // rematch but the token still needs to signal the parser
        if (!isEmbedded && action && typeof action !== 'string' && action.parser) {
          tokens.push({ type: '', start: pos0, end: pos, parser: action.parser })
          if (pushEmbedded) tokens.push({ type: '_NEST_', start: pushEmbedded, end: pushEmbedded })
        }
      }

      // do double checks on progress if we didn't match any characters
      if (matched.length === 0) {
        // if something was manipulated during this step, we'll assume we're doing fine and proceed
        if (lineLength === 0 || stackLen0 !== stack.depth || state !== stack.state || (!groupMatching ? 0 : groupMatching.groups.length) !== groupLen0)
          continue
        // if nothing changed at all, that means we're not moving
        else throw new Error(
          'no progress in tokenizer in rule: ' + safeRuleName(rule))
      }

      if (!isEmbedded) {
        // return the result (and check for brace matching)
        let tokenType: string | null = null
        // handle '@brackets' token types
        if (isString(result) && result.indexOf('@brackets') === 0) {
          let rest = result.substr(9) // 9 = '@brackets`.length
          let bracket = findBracket(lexer, matched)

          if (!bracket) throw new Error(
            '@brackets token returned but no bracket defined as: ' + matched)

          tokenType = sanitize(bracket.token + rest)
        }
        else tokenType = sanitize(result === '' ? '' : result.toString())

        // push normal tokens
        if (!tokenType.startsWith('@')) {
          const token = {
            type: tokenType, start: pos0, end: pos,
            parser: typeof action !== 'string' ? action.parser : undefined
          }
          // checking if we can merge this token with the last one
          if (last?.token && canContinueToken(last.token, token) && stackIsEqual(last.stack, stack))
            tokens[tokens.length - 1].end = pos
          else tokens.push(token)
        }
      }
      if (pushEmbedded) tokens.push({ type: '_NEST_', start: pushEmbedded, end: pushEmbedded })
    }
    // store the last state so that we can compare new tokens against an old ones (for merging them)
    last = { stack: stack.serialize(), token: tokens[tokens.length - 1] }
  }
  return { stack, tokens, poppedEmbedded }
}
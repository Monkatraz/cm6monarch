import { NodeSet, NodeType, Tree } from 'lezer-tree'
import { Language, LanguageSupport, languageDataProp, defineLanguageFacet, LanguageDescription } from '@codemirror/next/language'
import { Tag, tags, styleTags } from "@codemirror/next/highlight"

import { compile } from './monarch/monarchCompile.js'
import { createMonarchStack, MonarchStack, MonarchToken, stackIsEqual, tokenize } from './lexer.js'

import type { Input } from 'lezer'
import type { PartialParse } from 'lezer-tree'
import type { Extension } from '@codemirror/next/state'
import type { EditorParseContext } from '@codemirror/next/language'
import type { IMonarchLanguage, ILexer } from './monarch/monarchCommon'

type TagList = { [name: string]: Tag }

export interface MonarchLanguageDefinition {
  name: string
  lexer: IMonarchLanguage
  alias?: string[]
  ext?: string[]
  languageData?: { [name: string]: any }
  extraExtensions?: Extension[]
}

export interface MonarchLanguageData {
  load(): LanguageSupport
  tags: { [name: string]: Tag }
  description: LanguageDescription
  props: () => any[]
}

export function createMonarchLanguage(opts: MonarchLanguageDefinition): MonarchLanguageData {
  // general chores before we can do stuff with the data
  const langDesc = Object.assign(
    { name: opts.name },
    opts.alias ? { alias: opts.alias } : {},
    opts.ext ? { extensions: opts.ext } : {}
  )
  const langData = { ...langDesc, ...(opts.languageData ? opts.languageData : {}) }
  const lexer = compile(opts.lexer)

  // export tags
  const newTags: TagList = {}
  const unknownTags = Array.from(lexer.tokenTypes).filter(tag => !(tag in tags))
  unknownTags.forEach(tagName => newTags[tagName] = Tag.define())

  const props = () => {
    const dataFacet = defineLanguageFacet(langData)
    const parser = createMonarchState(lexer, newTags, dataFacet)
    const startParse = (input: Input, startPos: number, context: EditorParseContext) => {
      return monarchParse(parser, input, startPos, context)
    }
    return [dataFacet, { startParse }]
  }

  const load = function () {
    const dataFacet = defineLanguageFacet(langData)
    const parser = createMonarchState(lexer, newTags, dataFacet)
    const startParse = (input: Input, startPos: number, context: EditorParseContext) => {
      return monarchParse(parser, input, startPos, context)
    }
    const lang = new Language(dataFacet, { startParse })

    return new LanguageSupport(lang)
  }
  const description = LanguageDescription.of({ ...langDesc, load: async () => load() })

  return { props, load, tags: newTags, description }
}

// -- PARSER

// TODO: indent handling
// TODO: potentially find a way of line shifting (if new line, check next line for the string)
// TODO: embedded languages
// TODO: use monarch's brace handling automatically and get brace info into nodes
// TODO: add a 'configure()' field that works like a lezer parser
// TODO: add an 'inline' only mode for `opens` `closes`
// TODO: allow 'emphasis.slash' where the '.slash' makes the 'emphasis' more specific, but uses the same scope

// ? inspect tokens widgets? pls cm6 add it urself

// https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0#gistcomment-2694461
function quickHash(s: string) {
  let h = 0
  for (const c of s)
    h = Math.imul(31, h) + c.charCodeAt(0) | 0
  return h
}

/** Represents the state of a Monarch incremental parser. */
interface MonarchState {
  /** The compiled lexer used to tokenize input lines. */
  lexer: ILexer
  /** A mapping of node names to number IDs. (e.g. `'string'` -> `0`) */
  nodeMap: Map<string, number>
  /** The definitive list of node types used by the tokenizer. */
  nodeTypes: NodeType[]
  /** The parser's `NodeSet` - which is just `new NodeSet(nodeTypes)`. */
  nodeSet: NodeSet
  /** The parser's cache of lines / data buffer. */
  lines: MonarchLine[]
}

/** Creates a `MonarchState`. I know, boring - see the `MonarchState` interface. */
function createMonarchState(lexer: ILexer, newTags: TagList, dataFacet: any): MonarchState {

  const allTags: TagList = { ...tags as any, ...newTags }
  const nodeMap: Map<string, number> = new Map
  const nodeTypes: NodeType[] = []
  const nodeSet = new NodeSet(nodeTypes)
  const lines: MonarchLine[] = []

  nodeMap.set('document', 0)
  nodeTypes.push(new (NodeType as any)("document", languageDataProp.set(Object.create(null), dataFacet), 0))
  lexer.tokenTypes.forEach((name) => {
    const id = nodeMap.size
    nodeMap.set(name, id)
    nodeTypes.push(NodeType.define({
      name,
      id,
      // this weird trick potentially makes highlighting more reliable
      // if the user modifies the tags list before or after this state is made, this will catch it
      props: [styleTags({ get [name + '/...']() { return allTags[name] ?? tags.literal } })]
    }))
  })

  return {
    lexer,
    nodeMap,
    nodeTypes,
    nodeSet,
    lines
  }
}

type MappedToken = [type: number, start: number, end: number, opens: number, closes: number]

function compileMappedToken(token: MonarchToken, map: Map<string, number>): MappedToken {
  return [
    map.get(token.type)!,
    token.start,
    token.end,
    token.opens ? map.get(token.opens)! : 0,
    token.closes ? map.get(token.closes)! : 0
  ]
}

/** Represents a text line within the parser's cache. It is used to tokenize and compile strings as well. */
class MonarchLine {

  hash!: number
  length!: number
  startStack!: string[]
  endStack!: string[]
  tokens!: MappedToken[]
  lastOffset!: number
  lastBuffer!: MappedToken[]

  constructor (
    public state: MonarchState,
    public number: number,
    line: string
  ) {
    this.reset(line)
    this.tokenize(line)
  }

  /** Resets the line using the given string (and hash, if already calculated) (does not tokenize). */
  reset(line: string, hash?: number) {
    this.hash = hash ?? quickHash(line)
    this.length = line.length
    this.lastOffset = -1
    this.lastBuffer = []
  }

  /** Returns the line prior to this one. */
  prev() { return this.state.lines[this.number - 1] ?? null }

  /** Tokenizes the input string, and sets the line's state to reflect the result. */
  tokenize(line: string) {
    // get our starting state
    let stack: MonarchStack
    const lastLine = this.prev()
    if (lastLine) stack = createMonarchStack(lastLine.endStack)
    else stack = createMonarchStack([this.state.lexer.start ?? 'root'])
    this.startStack = stack.serialize()
    // tokenize
    const result = tokenize({ line, lexer: this.state.lexer, stack })
    this.tokens = result.tokens.map((token) => compileMappedToken(token, this.state.nodeMap))
    this.endStack = stack.serialize()
  }

  /** Compiles the line's tokens into a linebuffer, with every position offset by the given `offset` value. */
  compile(offset: number) {
    if (this.lastOffset !== offset) {
      this.lastBuffer = this.tokens.map(
        token => [token[0], offset + token[1], offset + token[2], token[3], token[4]])
      this.lastOffset = offset
    }
    return this.lastBuffer
  }

  /** Compares an input string to the current state.
   *  If the input is different from the state, the state will update to match the input.
   *  This function will return false if the lines are the same, and true if they differ.
   */
  eval(input: string) {
    let inHash: number | undefined
    let invalid = false
    const lastLine = this.prev()
    if (lastLine && !stackIsEqual(lastLine.endStack, this.startStack)) invalid = true
    else if (input.length !== this.length) invalid = true
    else if ((inHash = quickHash(input)) !== this.hash) invalid = true

    if (!invalid) return false
    else {
      this.reset(input, inHash)
      this.tokenize(input)
      return true
    }
  }
}

/** Returns a `PartialParse` compatible incremental parser using the given `MonarchState`. */
function monarchParse(state: MonarchState, input: Input, start: number, context: EditorParseContext): PartialParse {

  // set our viewport / start-end markers
  if (start < context.viewport.from) start = context.viewport.from
  const viewportEndLine = context.state.doc.lineAt(context.viewport.to).number - 1

  // next we want our list of lines from the document, but with them clipped to the input length
  const docLines = context.state.doc.slice(0, input.length).toJSON()

  // current line idx
  let idxLine = context.state.doc.lineAt(start).number - 1

  // we don't actually use a character pos, so we fake a function for it
  let early = false
  const pos = () => {
    if (!early) return idxLine > docLines.length ? input.length : context.state.doc.line(idxLine).from
    else return input.length
  }

  // this function is called whenever codemirror wants to kill the parser and get the result
  // it's also called when the parser itself has nothing left to do (or leaves early)
  const getTree = () => {
    // go through the cache/lines and get all of our tokens in a list
    // we make sure to only go for as many lines as we're actually parsing
    let offset: number = 0
    const tokens = state.lines.slice(0, docLines.length).flatMap(line => {
      let lineTokens = line.compile(offset)
      offset += line.length + 1
      return lineTokens
    })

    // here we're going to process `opens` and `closes` data and make an actually nesting tree
    let stack: [name: number, start: number, children: number][] = []
    const buffer: number[] = []
    for (const token of tokens) {
      // order must be [closes -> token -> opens]
      // closing
      let closed = 0
      if (token[4] && stack.length) {
        const idx = stack.map(state => state[0]).lastIndexOf(token[4])
        if (idx !== -1) {
          // cuts off anything past our closing stack element
          stack = stack.slice(0, idx + 1)
          const state = stack.pop()!
          buffer.push(state[0], state[1], token[1], (state[2] * 4) + 4)
          stack.forEach(state => state[2]++)
          closed = 1
        }
      }
      // actual token itself
      buffer.push(token[0], token[1], token[2], 4)
      stack.forEach(state => state[2]++)
      // opening
      if (token[3] && (token[3] !== token[4] || (token[3] === token[4] && !closed))) {
        stack.forEach(state => state[2]++) // needs to go first
        stack.push([token[3], token[2], 0])
      }
    }
    // handle unfinished stack
    // if (stack.length) stack.forEach(state => {
    //   buffer.push(state[0], state[1], pos(), (state[2] * 4) + 4)
    // })

    // compile our huge ass tree
    const tree = Tree.build({
      buffer: buffer,
      length: pos(),
      topID: 0,
      nodeSet: state.nodeSet
    })
    // console.log(
    //   'start (ch): ' + start + ' | ' + 'ended (line): ' + idxLine + ' | ' + (buffer.length / 4) + ' tokens')
    return tree
  }

  return {
    // this advances the parser one line and returns 'null' to signify it has done so
    // or, it may parse one line and then be 'complete', and return the parse tree
    // the advancing is controlled entirely by codemirror's scheduler
    advance() {
      const line = docLines[idxLine]
      const cachedLine = state.lines[idxLine]
      let lineUpdated = true
      if (cachedLine) lineUpdated = cachedLine.eval(line)
      else state.lines[idxLine] = new MonarchLine(state, idxLine, line)

      idxLine++

      // this basically catches when the user is just changing a single line
      // it will skip early if past the viewport and just use whatever is already in the cache until EOS
      if (docLines.length === state.lines.length && !lineUpdated && idxLine > viewportEndLine) {
        early = true
        return getTree()
      }

      // EOS
      if (idxLine >= docLines.length) return getTree()
      // parsed one line, ready for next advance call
      else return null
    },
    // these two functions complete the interface
    get pos() { return pos() },
    forceFinish() { return getTree() }
  }
}
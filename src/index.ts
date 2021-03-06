import { NodeSet, NodeType, Tree, stringInput } from 'lezer-tree'
import { Language, EditorParseContext, LanguageSupport, languageDataProp, defineLanguageFacet, LanguageDescription } from '@codemirror/language'
import { Tag, tags, styleTags } from "@codemirror/highlight"

import { compile } from './monarch/monarchCompile'
import { MonarchStack, stackIsEqual, tokenize } from './lexer'

import type { Input } from 'lezer'
import type { PartialParse, NodePropSource } from 'lezer-tree'
import type { Extension } from '@codemirror/state'
import type { MonarchToken, MonarchEmbeddedRange } from './lexer'
import type { IMonarchLanguage, ILexer } from './monarch/monarchCommon'

type TagList = { [name: string]: Tag }

/** The options / interface required to create a Monarch language. */
export interface MonarchLanguageDefinition {
  /** The name of the language. This is actually important for CodeMirror, so make sure it's correct. */
  name: string
  /** The Monarch lexer that will be used to tokenize the language. */
  lexer: IMonarchLanguage
  /** A list of `LanguageDescription` objects that will be used when the parser nests in a language. */
  nestLanguages?: LanguageDescription[]
  /** Configuration options for the parser, such as node props. */
  configure?: MonarchConfigure
  /** A list of aliases for the name of the language. (e.g. 'go' -> ['golang']) */
  alias?: string[]
  /** A list of file extensions. (e.g. ['.ts']) */
  ext?: string[]
  /** The 'languageData' field for the language. CodeMirror plugins use this data to interact with the language. */
  languageData?: { [name: string]: any }
  /** Extra extensions to be loaded. */
  extraExtensions?: Extension[]
}

/** An object containing the various utilites / loaders generated by a Monarch language. */
export interface MonarchLanguageData {
  /** Creates a `LanguageSupport` object that can be used like an ordinary language/extension. */
  load(): LanguageSupport
  /** A list of new `Tag` objects generated automatically from the language definition. */
  tags: { [name: string]: Tag }
  /** A `LanguageDescription` object, commonly used for nesting languages. */
  description: LanguageDescription
}

/** Creates a new Monarch-based language.
 *  It returns an object containing:
 *
 *  | | |
 *  | :-- | :-- |
 *  | `load()` | a function used to load the language as an extension/`LanguageSupport` |
 *  | `description` | a `LanguageDescription` object, commonly used for nesting |
 *  | `tags` | a list of new `Tag` objects generated automatically from the language definition |
 */
export function createMonarchLanguage(opts: MonarchLanguageDefinition): MonarchLanguageData {
  // general chores before we can do stuff with the data
  const langDesc = Object.assign(
    { name: opts.name },
    opts.alias ? { alias: opts.alias } : {},
    opts.ext ? { extensions: opts.ext } : {}
  )
  const langData = { ...langDesc, ...(opts.languageData ?? {}) }
  const lexer = compile(opts.lexer)

  // export tags
  const newTags: TagList = {}
  const unknownTags = Array.from(lexer.tokenTypes).filter(tag => !(tag in tags))
  unknownTags.forEach(tagName => { if (tagName) newTags[tagName] = Tag.define() })

  const load = function () {
    const dataFacet = defineLanguageFacet(langData)
    const parser = createMonarchState(
      { lexer, configure: opts.configure ?? {}, tags: newTags, dataFacet, nestLanguages: opts.nestLanguages ?? [] })
    const startParse = (input: Input, startPos: number, context: EditorParseContext) => {
      return monarchParse(parser, input, startPos, context)
    }
    const lang = new Language(dataFacet, { startParse }, parser.nodeTypes[0])

    return new LanguageSupport(lang)
  }
  const description = LanguageDescription.of({ ...langDesc, load: async () => load() })

  return { load, tags: newTags, description }
}

// -- PARSER

// TODO: use monarch's brace handling automatically and get brace info into nodes
// TODO: allow 'emphasis.slash' where the '.slash' makes the 'emphasis' more specific, but uses the same scope
// TODO: use the tree fragments to get the exact edited text positions (relatively close, anyways)
// TODO: add action.transform
// (matches, stack) => FuzzyAction | FuzzyAction[] | null

// https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0#gistcomment-2694461
/** Very quickly generates a (non-secure) hash from the given string. */
export function quickHash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++)
  	h = Math.imul(31, h) + s.charCodeAt(i) | 0
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
  /** The list of languages available for nesting. */
  nestLanguages: LanguageDescription[]
}

interface MonarchConfigure {
  props?: NodePropSource[]
}

/** The data required to init. a `MonarchState`. */
interface MonarchStateOpts {
  /** A compiled lexer from a Monarch language. */
  lexer: ILexer
  /** Configuration options for the parser, such as node props. */
  configure: MonarchConfigure
  /** A list of new tags added by the lexer. */
  tags: TagList
  /** The `Facet` used to identify the language in the syntax tree. */
  dataFacet: ReturnType<typeof defineLanguageFacet>
  /** Languages used by the parser when nesting. */
  nestLanguages: LanguageDescription[]
}

/** Creates a `MonarchState`. I know, boring - see the `MonarchState` interface. */
function createMonarchState(
  { lexer, configure, tags: newTags, dataFacet, nestLanguages }: MonarchStateOpts): MonarchState {

  const allTags: TagList = { ...tags as any, ...newTags }
  const lines: MonarchLine[] = []
  const nodeMap: Map<string, number> = new Map
  let nodeTypes: NodeType[] = []
  let nodeSet = new NodeSet(nodeTypes)

  // this sets the language data facet on the top-most node of the language
  // the facet is how CodeMirror determines what language a region is using
  nodeMap.set('document', 0)
  nodeTypes.push(new (NodeType as any)("document", languageDataProp.set(Object.create(null), dataFacet), 0))
  // go through each token type and add it to our NodeTypes list
  lexer.tokenTypes.forEach((name) => {
    const id = nodeMap.size
    nodeMap.set(name, id)
    let props: NodePropSource[] = []
    // check if the scope should be styled as a syntax highlighting tag (lower case)
    if (name[0].toUpperCase() !== name[0])
      props.push(styleTags({ [name + '/...']: allTags[name] ?? NodeType.none }))
    // push finished type
    nodeTypes.push(NodeType.define({ name, id, props }))
  })

  if ('props' in configure) nodeSet = nodeSet.extend(...configure.props!)

  // since the state doesn't actually do anything by itself it's probably best as simply an object
  return {
    lexer,
    nodeMap,
    nodeTypes,
    nodeSet,
    lines,
    nestLanguages
  }
}

/** Directs the parser to nest tokens using the node's type ID. */
type MappedParserAction = [id: number, inclusive: number][]

/** A more efficient representation of `MonarchToken` used in the parser.  */
type MappedToken = [type: number, start: number, end: number, open?: MappedParserAction, close?: MappedParserAction]

/** Compiles a mapped token from a `MonarchToken` and a mapping of scope names to `NodeType` IDs. */
function compileMappedToken(token: MonarchToken, map: Map<string, number>): MappedToken {
  let parserOpenAction: MappedParserAction | undefined
  let parserCloseAction: MappedParserAction | undefined
  if (token.parser) {
    for (const type of ['open', 'close', 'start', 'end']) {
      const closing = type === 'close' || type === 'end'
      const inclusivity = +(type === 'start' || type === 'end')
			const scopes = (token.parser as any)[type] as string | string[] | undefined
			if (typeof scopes === 'string') {
        if (!closing) parserOpenAction = [[map.get(scopes)!, inclusivity]]
        else parserCloseAction = [[map.get(scopes)!, inclusivity]]
      } else if (scopes) {
        if (!closing) parserOpenAction = scopes.map(scope => [map.get(scope)!, inclusivity])
        else parserCloseAction = scopes.map(scope => [map.get(scope)!, inclusivity])
      }
		}
  }
  let tokenType = 0
  if (token.type === '_NEST_') tokenType = -1
  else if (token.type) tokenType = map.get(token.type)!
  return [
    tokenType,
    token.start,
    token.end,
    parserOpenAction,
    parserCloseAction
  ]
}

class MonarchEmbeddedParser {
  lang: LanguageDescription | null = null
  hash: number = 0
  cache: Tree = Tree.empty

  constructor (
    public state: MonarchState,
    public range: MonarchEmbeddedRange
  ) {
    if (state.nestLanguages.length) {
      this.lang = LanguageDescription.matchLanguageName(state.nestLanguages, range.lang)
      if (this.lang) this.lang.load()
    }
  }

  getParser() {
    if (this.lang?.support) {
      // parser loaded
      const host = this.lang.support.language
      return (input: string, startPos: number) => {
        const hash = quickHash(input)

        if (hash === this.hash && this.cache.length > 0) {
          // result already cached, return 'fake' `PartialParse`
          this.hash = hash
          const cache = this.cache
          return { advance() { return cache }, get pos() { return input.length }, forceFinish() { return cache } }
        } else {
          // actual parser from language
          this.hash = hash
          if ('streamParser' in host) {
            // can't use a stream parser incrementally, due to it requiring a context
            const tree = (host as Language).parseString.bind(host)(input)
            return { advance() { return tree }, get pos() { return input.length }, forceFinish() { return tree } }
          }
          return host.parser.startParse.bind(host.parser)(stringInput(input), startPos, {})
        }
      }
    }
    // parser not ready yet
    return (input: string, startPos: number, context: EditorParseContext) =>
      EditorParseContext.skippingParser.startParse(stringInput(input), startPos, context)
  }
}

/** Represents a text line within the parser's cache. It is used to tokenize and compile strings as well. */
class MonarchLine {

  hash!: number
  length!: number
  startStack!: string[]
  endStack!: string[]
  tokens!: MappedToken[]
  embeds!: MonarchEmbeddedParser[]
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
    if (lastLine) stack = new MonarchStack(lastLine.endStack)
    else stack = new MonarchStack([this.state.lexer.start ?? 'root'])
    this.startStack = stack.serialize()
    // tokenize
    const result = tokenize({ line, lexer: this.state.lexer, stack })
    this.tokens = result.tokens.map((token) => compileMappedToken(token, this.state.nodeMap))
    this.embeds = result.poppedEmbedded.map(range => new MonarchEmbeddedParser(this.state, range))
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

function treeFromState(state: MonarchState, to: number, pos: number) {
    // go through the cache/lines and get all of our tokens in a list
    let offset: number = 0
    const embeds: Tree[] = []
    const tokens = state.lines.slice(0, to).flatMap(line => {
      let lineTokens = line.compile(offset)
      offset += line.length + 1
      embeds.push(...line.embeds.map(embed => embed.cache))
      return lineTokens
    })

    // here we're going to process `opens` and `closes` data and make an actually nesting tree
    let embedIdx = 0
    let stack: [name: number, start: number, children: number][] = []
    const increment = () => stack.forEach(state => state[2]++)
    const buffer: number[] = []
    for (const token of tokens) {

      const [type, start, end, open, close] = token

      // nesting lang handling
      if (type === -1) {
        // undocumented features !!!!
        // passing a -1 to the size tells the tree builder to use the `reused` property
        // the ID of the token determines which slot in `reused` will take the place of this token
        buffer.push(embedIdx, start, end, -1)
        embedIdx++
        increment()
      } else {
        // closing
        if (close && stack.length) close.forEach(([id, inclusive]) => {
          const idx = stack.map(state => state[0]).lastIndexOf(id)
          if (idx !== -1) {
            // cuts off anything past our closing stack element
            stack = stack.slice(0, idx + 1)
            // if we're inclusive of the end token we need to include it before we end the state
            if (type && inclusive) {
              buffer.push(type, start, end, 4)
              increment()
            }
            const [startid, startpos, children] = stack.pop()!
            buffer.push(startid, startpos, inclusive ? end : start, (children * 4) + 4)
            increment()
          }
        })

        // token itself
        if (type && !(close && close[0][1])) {
          buffer.push(type, start, end, 4)
          increment()
        }
        // opening
        if (open) open.forEach(([id, inclusive]) => {
          stack.push([id, inclusive ? start : end, type && inclusive ? 1 : 0])
        })
      }
    }
    // handle unfinished stack
    while (stack.length) {
      const [startid, startpos, children] = stack.pop()!
      buffer.push(startid, startpos, pos, (children * 4) + 4)
      stack.forEach(state => state[2]++)
    }

    // handle embeddeds that never finish by replacing them with empty trees
    while (embeds.length <= embedIdx) embeds.push(Tree.empty)

    const tree = Tree.build({
      buffer: buffer,
      length: pos,
      topID: 0,
      reused: embeds,
      nodeSet: state.nodeSet
    })

    return tree
}

function monarchSimpleParse(hostState: MonarchState, input: Input, start: number) {

  const state: MonarchState = { ...hostState, lines: [] }

  // next we want our list of lines from the document, but with them clipped to the input length
  const text = input.read(start, input.length)
  const docLines = text.split('\n')

  const newlines = text.matchAll(/\n/g)
  const froms: number[] = [0]
  for (const match of newlines) {
    if (match.index) froms.push(match.index + 1)
  }

  // current line idx
  let idxLine = 0

  // nesting, a line may have multiple nested langs so it needs to have an inline index
  let nesting = false
  let nestingIdx = 0
  let nestingParser: PartialParse | null = null

  // we don't actually use a character pos, so we fake a function for it
  const pos = () => { return froms[idxLine] }

  const getTree = () => treeFromState(state, docLines.length, pos())

  return {
    // this advances the parser one line and returns 'null' to signify it has done so
    // or, it may parse one line and then be 'complete', and return the parse tree
    // the advancing is controlled entirely by codemirror's scheduler
    advance() {
      const line = docLines[idxLine]
      let cachedLine = state.lines[idxLine]
      if (!cachedLine) {
        state.lines[idxLine] = new MonarchLine(state, idxLine, line)
        cachedLine = state.lines[idxLine]
      }

      // not parsing nested but needs to be
      if (!nesting && cachedLine.embeds[nestingIdx]) {
        nesting = true
        const embed = cachedLine.embeds[nestingIdx]
        // get absolute start and end from the relative line offsets
        const start = froms[idxLine - embed.range.line] + embed.range.start
        const end = froms[idxLine] + embed.range.end
        nestingParser = embed.getParser()(input.read(start, end), 0, {} as any)
      }

      // already parsing nested
      if (nesting && nestingParser) {
        const done = nestingParser.advance()
        if (done) {
          nesting = false
          nestingParser = null
          cachedLine.embeds[nestingIdx].cache = done
          nestingIdx++
        }
        else return null
      }

      // reset for next line
      nestingIdx = 0
      idxLine++

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

/** Returns a `PartialParse` compatible incremental parser using the given `MonarchState`. */
function monarchParse(state: MonarchState, input: Input, start: number, context: EditorParseContext): PartialParse {

  if (!context.state) return monarchSimpleParse(state, input, start)

  // set our viewport / start-end markers
  if (start < context.viewport.from) start = context.viewport.from
  const viewportEndLine = context.state.doc.lineAt(context.viewport.to).number - 1

  // next we want our list of lines from the document, but with them clipped to the input length
  const docLines = context.state.doc.slice(0, input.length).toJSON()

  // current line idx
  let idxLine = context.state.doc.lineAt(start).number - 1

  // nesting, a line may have multiple nested langs so it needs to have an inline index
  let nesting = false
  let nestingIdx = 0
  let nestingParser: PartialParse | null = null

  // we don't actually use a character pos, so we fake a function for it
  let early = false
  const pos = () => {
    if (!early) return idxLine > docLines.length ? input.length : context.state.doc.line(idxLine).from
    else return input.length
  }

  const getTree = () => treeFromState(state, docLines.length, pos())

  return {
    // this advances the parser one line and returns 'null' to signify it has done so
    // or, it may parse one line and then be 'complete', and return the parse tree
    // the advancing is controlled entirely by codemirror's scheduler
    advance() {
      const line = docLines[idxLine]
      let cachedLine = state.lines[idxLine]
      let lineUpdated = true
      if (cachedLine) lineUpdated = cachedLine.eval(line)
      else {
        state.lines[idxLine] = new MonarchLine(state, idxLine, line)
        cachedLine = state.lines[idxLine]
      }

      // not parsing nested but needs to be
      if (!nesting && cachedLine.embeds[nestingIdx]) {
        nesting = true
        const embed = cachedLine.embeds[nestingIdx]
        // get absolute start and end from the relative line offsets
        const start = context.state.doc.line(idxLine - embed.range.line + 1).from + embed.range.start
        const end = context.state.doc.line(idxLine + 1).from + embed.range.end
        nestingParser = embed.getParser()(input.read(start, end), 0, context)
      }

      // already parsing nested
      if (nesting && nestingParser) {
        const done = nestingParser.advance()
        if (done) {
          nesting = false
          nestingParser = null
          cachedLine.embeds[nestingIdx].cache = done
          nestingIdx++
        }
        else return null
      }

      // reset for next line
      nestingIdx = 0
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

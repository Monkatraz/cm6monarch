# `cm6-monarch`
<a href="https://www.npmjs.com/package/cm6-monarch">
<img src="https://img.shields.io/npm/v/cm6-monarch">
</a>

This is a 'fork' of the [Monaco Editor's](https://github.com/Microsoft/monaco-editor) Monarch syntax highlighter to [CodeMirror 6](https://github.com/codemirror/codemirror.next/). It is generally compatible with Monaco Editor language sources. In contrast to the original implementation, this version of Monarch has been _radically supercharged_ with many backend improvements. The most useful new features are likely the action `parser` syntax tree additions, and the usage of sticky regexes in the backend, allowing for full lookbehind support.

**Please note:** This isn't done. It does work - and I don't think it's too buggy, but it's still got a little ways to go before I can consider it done. It's mainly missing quality of life features.

## Usage
If you're wanting to make a language using Monarch, the [official tutorial/playground](https://microsoft.github.io/monaco-editor/monarch.html) can be helpful, with the examples being something you should look at. However, if you need a _reference_, I have written a replacement document with a complete description of all presently supported syntax and features, in the [`docs/syntax.md`](docs/syntax.md) file. There is some significant additions, although basically only non-breaking ones, like lookbehind support.

A few things to note:
- Don't use this if you think you can make a [Lezer](https://lezer.codemirror.net/) grammar. CodeMirror does better with a proper parser.
- You should use the [CodeMirror 6 highlighter tags](https://codemirror.net/6/docs/ref/#highlight.tags). You can actually use your own tags/scopes, the language will automatically create them and export them for you. However, using these is not advised because they'll be entirely custom to your language and hard to support.
- You can now nest scopes, albeit not as nicely as states - check the [`docs/syntax.md`](docs/syntax.md) file (at the bottom) to learn more. The nesting is done as a parser directive, and what I mean is that the parser will actually create a syntax tree from your `parser` directives. You can use this to add code folding and all kinds of other syntax node related features.

To actually, y'know, use it in the code, it looks like this:
```ts
import { createMonarchLanguage } from 'cm6-monarch'

// Just for reference, this is the configuration interface.
interface MonarchLanguageDefinition {
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

// And what it returns:
interface MonarchLanguageData {
  /** Creates a `LanguageSupport` object that can be used like an ordinary language/extension. */
  load(): LanguageSupport
  /** A list of new `Tag` objects generated automatically from the language definition. */
  tags: { [name: string]: Tag }
  /** A `LanguageDescription` object, commonly used for nesting languages. */
  description: LanguageDescription
}

// This uses the lexer given in the Monarch tutorial.
// const { load, tags, description } = createMonarchLanguage({
const myLanguage = createMonarchLanguage({
  name: 'myLang',
  lexer: {
    // defaultToken: 'invalid',
    keywords: [
      'abstract', 'continue', 'for', 'new', 'switch', 'assert', 'goto', 'do',
      'if', 'private', 'this', 'break', 'protected', 'throw', 'else', 'public',
      'enum', 'return', 'catch', 'try', 'interface', 'static', 'class',
      'finally', 'const', 'super', 'while', 'true', 'false'
    ],
    typeKeywords: [
      'boolean', 'double', 'byte', 'int', 'short', 'char', 'void', 'long', 'float'
    ],
    operators: [
      '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
      '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
      '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=',
      '%=', '<<=', '>>=', '>>>='
    ],
    symbols:  /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        // identifiers and keywords
        [/[a-z_$][\w$]*/, { cases: {'@typeKeywords': 'keyword',
                                    '@keywords': 'keyword',
                                    '@default': 'identifier' } }],
        [/[A-Z][\w\$]*/, 'type.identifier' ],  // to show class names nicely

        // whitespace
        { include: '@whitespace' },

        // delimiters and operators
        [/[{}()\[\]]/, '@brackets'],
        [/[<>](?!@symbols)/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator',
                                '@default'  : '' } } ],

        // @ annotations.
        // As an example, we emit a debugging log message on these tokens.
        // Note: message are supressed during the first load -- change some lines to see them.
        [/@\s*[a-zA-Z_\$][\w\$]*/, { token: 'annotation', log: 'annotation token: $0' }],

        // numbers
        [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\d+/, 'number'],

        // delimiter: after number because of .\d floats
        [/[;,.]/, 'delimiter'],

        // strings
        [/"([^"\\]|\\.)*$/, 'string.invalid' ],  // non-teminated string
        [/"/,  { token: 'string.quote', bracket: '@open', next: '@string' } ],

        // characters
        [/'[^\\']'/, 'string'],
        [/(')(@escapes)(')/, ['string','string.escape','string']],
        [/'/, 'string.invalid']
      ],

      comment: [
        [/[^\/*]+/, 'comment' ],
        [/\/\*/,    'comment', '@push' ],    // nested comment
        ["\\*/",    'comment', '@pop'  ],
        [/[\/*]/,   'comment' ]
      ],

      string: [
        [/[^\\"]+/,  'string'],
        [/@escapes/, 'string.escape'],
        [/\\./,      'string.escape.invalid'],
        [/"/,        { token: 'string.quote', bracket: '@close', next: '@pop' } ]
      ],

      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [/\/\*/,       'comment', '@comment' ],
        [/\/\/.*$/,    'comment'],
      ],
    }
  }
})

// And this is how you would load it in the editor:

import {EditorState} from "@codemirror/state"
import {EditorView, keymap} from "@codemirror/view"
import {defaultKeymap} from "@codemirror/commands"
import {defaultHighlightStyle} from '@codemirror/highlight'

const startState = EditorState.create({
  doc: "Hello World",
  extensions: [
    keymap.of(defaultKeymap),
    defaultHighlightStyle,
    myLanguage.load()
  ]
})

const view = new EditorView({
  state: startState,
  parent: document.body
})

// Note that `description` is also exported by the creation function.
// The `description` object is a `LanguageDescription`,
// which are most commonly used to load nested grammars.

// The `lang-markdown` language supports these, so just to show how that works:

import { markdown } from '@codemirror/lang-markdown'

const myBetterStartState = EditorState.create({
  doc: "Hello World",
  extensions: [
    keymap.of(defaultKeymap),
    defaultHighlightStyle,
    markdown({ codeLanguages: [myLanguage.description] })
  ]
})

// You could of course do this the other way around,
// and nest `LanguageDescription`s in the language you created.

```
---

## Why?
![The dark lord cometh](https://i.imgur.com/ARu4tSR.png)
![it gets worse](https://i.imgur.com/9jmE31R.png)
----
God, I ask myself that every day.

Anyways, it's because Monarch uses _regex_, and this particular version of it supports stupidly flexible regex. If you're a regex wizard, you'll like this.

To be more specific about _why_, we'll start with a comparison to Lezer, which is the parser CodeMirror 6 normally uses. Lezer is a proper parser, capable of outputting beautiful syntax trees with stunningly simple grammar definitions. Seriously - go look at the official Lezer grammar for `json` files - it's really tiny and simple to understand. This parser can't do that. 

However, Monarch enthusiastically allows you to do sickening, awful things. It has almost none of the restrictions that Lezer has. This parser can back up its input as far as you like, rematch against a token, enter pseudo not real states, allows you to use the name of those phantom states in the branching paths and token names (wtf), now fully supports lookbehind, and probably worse things that I haven't even discovered yet. It supports all of this while not really being all that hard to use, as long as you know some regex.

If you're making an extension to Markdown, cobbling together a wiki-lang, creating a DSL, etc. this parser might be perfect for you. It lets you get syntax highlighting easily. If you're writing a proper grammar for a, uh, less _barbaric_ language, you'll want to make a Lezer grammar so that you get a proper syntax tree.

### Is it fast?
I think! It's definitely not slow. Monarch's runtime tokenizer is actually really tiny and simple. The most complex portions of Monarch are almost certainly its lexer compiling. The runtime itself uses _a lot_ of caching in the backend, and tries not to eat your RAM while it does it. I don't know yet how it handles really huge documents, but it's probably not too bad, and there is still some avenues for further optimization.

### Did you make this because your special snowflake version of Markdown needed syntax highlighting?
Yes.

![](https://i.imgur.com/b2fQ6RW.png)

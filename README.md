# `cm6-monarch`
This is a 'fork' of the [Monaco Editor's](https://github.com/Microsoft/monaco-editor) Monarch syntax highlighter to [CodeMirror 6](https://github.com/codemirror/codemirror.next/). It is generally compatible with Monaco Editor language sources. In contrast to the original implementation, this version of Monarch has been _radically supercharged_ with many backend improvements. The most useful new features are likely the `opens`, `closes` syntax tree additions, and the usage of sticky regexes in the backend, allowing for full lookbehind support.

**Please note:** This isn't done. It does work - and I don't think it's too buggy, but it's missing a few essential features. I'm working on it!

## Usage
If you're wanting to make a language using Monarch, the [official tutorial/playground](https://microsoft.github.io/monaco-editor/monarch.html) is actually pretty good. A few things to note:
- Don't use this if you think you can make a [Lezer](https://lezer.codemirror.net/) grammar. CodeMirror does better with a proper parser.
- Currently language nesting isn't supported, I plan to get this working soon.
- You should use the [CodeMirror 6 highlighter tags](https://codemirror.net/6/docs/ref/#highlight.tags). You can actually use your own tags/scopes, the language will automatically create them and export them for you. However, using these is not advised because they'll be entirely custom to your language and hard to support.
- The `brackets` features won't do anything - they didn't even do anything in the Monaco Editor.
- There is no `tokenPostFix` or `outdentTriggers` properties.
- Unlike Monarch's original implementation, this version supports lookbehind, which is of course hilariously dangerous.
- The only significant change to the grammar definitions is the addition of the `opens` and `closes` properties in rule actions, which I need to get around to documenting. The gist is that they allow you to state whether a token opens or closes a scope, and that will show up in the final syntax tree. This allows you to nest scopes, which you could not do in the original Monarch.

To actually, y'know, use it in the code, it looks like this:
```ts
import { createMonarchLanguage } from 'cm6-monarch'

// Just for reference, this is the configuration interface.
interface MonarchLanguageDefinition {
  name: string
  lexer: IMonarchLanguage
  configure?: {
    props?: NodePropSource[]
  }
  alias?: string[]
  ext?: string[]
  languageData?: { [name: string]: any }
  extraExtensions?: Extension[]
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
// The `description` object is a `LanguageDescription`, which are most commonly used to load nested grammars.

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

```
---

## Why?
![The dark lord cometh](https://i.imgur.com/ARu4tSR.png)
![it gets worse](https://i.imgur.com/9jmE31R.png)
----
God, I ask myself that every day.

Anyways, it's because Monarch uses _regex_, and this particular version of it supports stupidly flexible regex. If you're a regex wizard, you'll like this.

To be more specific about _why_, we'll start with a comparison to Lezer, which is the parser CodeMirror 6 normally uses. Lezer is a proper parser, capable of outputting beautiful syntax trees with stunningly simple grammar definitions. Seriously - go look at the official Lezer grammar for `json` files - it's really tiny and simple to understand. This parser can't do that. 

However, Monarch enthusiastically allows you to commit disturbing war crimes. It has almost none of the restrictions that Lezer has. This parser can back up its input as far as you like, rematch against a token, enter phantom states, allows you to use the name of those phantom states in the tokens (wtf), now fully supports lookbehind, and probably worse things that I haven't even discovered yet. It supports all of this while not really being all that hard to use, as long as you know some regex.

If you're making an extension to Markdown, cobbling together a wiki-lang, creating a DSL, etc. this parser might be perfect for you. It lets you get syntax highlighting easily. If you're writing a proper grammar for a, uh, less _barbaric_ language, you'll want to make a Lezer grammar so that you get a proper syntax tree.

### Is it fast?
I think! It's definitely not slow. Monarch's runtime tokenizer is actually really tiny and simple. The most complex portions of Monarch are almost certainly its lexer compiling. The runtime itself uses _a lot_ of caching in the backend, and tries not to eat your RAM while it does it. I don't know yet how it handles really huge documents - but in theory, the method of caching the parser is using is being used to fullest extent it probably can be.

### Did you make this because your special snowflake version of Markdown needed syntax highlighting?
Yes.

![](https://i.imgur.com/b2fQ6RW.png)

### Can I get some more technical details?
Sure! Generally, Monarch is through-and-through designed to be a simple to use tokenizer. It (in its original form) could not even nest scopes - each token got one scope, and one scope only. 

Adapting it to CodeMirror 6 required that it put out a `lezer-tree` compatible `Tree` for the incremental parser interface that CodeMirror 6 wants. To do this, this `cm6-monarch` takes the simplest approach possible, and assembles a giant freakin' buffer that it feeds into the `lezer-tree` builder.

A 'token' in Lezer looks like this:
```ts
type LezerToken = [NodeType: number, start: number, end: number, size: number]
```
However, you won't find tokens like this. It's not as simple as `[LezerToken, LezerToken, ...]`. Instead, those 4 numbers are just shoved in one buffer array in order. Parents come last - the `size` number is the amount of space in the array that node takes up. A node with no children takes up 4 slots in the array, a node with one child would take up 8. It should be noted that this is only the most basic form a syntax node can take in Lezer, a more complex tree structure could be used as well.

On a fundamental level, it's fairly simple to get Monarch to output Lezer tokens. This version of Monarch outputs this as its token:
```ts
type MonarchToken = 
{ token: string, start: number, end: number, opens?: string, closes?: string }
//                                              ^ shhhhhhhh war crimes
```
Monarch parses _one line at a time_. The start and end numbers are relative to the start of the line, they're not offsets from the start of the file. Regardless, you can see how the conversion between a `LezerToken` and a `MonarchToken` would be pretty simple if you know the line offsets.

When all of these tokens are assembled, you get a big, long list of numbers. That's what is given to CodeMirror.

In order to not be stupidly slow, the parser caches information about each line in the file. The information stored, like the stack and tokens, allows the parser to start from practically anywhere in the file without needing to reparse anything prior. Additionally, the parser is smart enough to avoid parsing _too much_, and it will stop if it can just use the cache ahead as well.

Finally, the parser has a rudimentary syntax tree stack. Tokens can provide an `opens` or `closes` value, which tells the parser to 'wrap' everything after (or close the wrapping) that token with a specific scope. This is directly output into the CodeMirror syntax tree - and it can be used for things like code-folding, not just syntax highlighting. Despite the pretty tiny size of this system in the code, it's actually fairly well-behaved.

Of course, I'm skipping over quite a few technical details. There is a lot to talk about with CodeMirror - it's really, _really_ different in the backend in comparison to something like VSCode. What it gets for this complexity/efficiency is blazing fast single thread performance, and that's awesome.

# Monarch Tokenizer Syntax

This document is a mostly dry, precise description of all of the various constructs you can use in a tokenizer. It is to serve as a reference. The order of this list is from the 'largest' objects to the 'smallest' - beginning with root, states, and ending with parser directives.

## Tokenization

However, first we will describe how Monarch actually interacts with a document, as that is essential in understanding how to program the tokenizer.

Fundamentally, Monarch is a line-based tokenizer. What this means is that your document will first be broken into lines, and then for every line Monarch will output a series of contiguous tokens that describe the syntax highlighting for that line.

When Monarch attempts to match regular expressions against the document, it only does so _per-line_. A regular expression will not be able to 'see' prior to the start of the line nor past the end of it. Any rules that are written for Monarch need to be written with these limitations in mind.

## Root

The root of the language object, where the tokenizer is defined in the `tokenizer` property, can host several other properties. A special property type called an _attribute_ can be used within the tokenizer - see _regex_ within the description of the _rules_ objects.

The special properties, other than `tokenizer`, follow:
| | |
| :-- | :-- |
| `ignoreCase` | Defaults to `false`. If `true`, the language will automatically compile regular expressions to be case-insensitive.
| `defaultToken` | Defaults to `''`. If the tokenizer cannot match some text to any rule, it will move forward a single character and assign the last character with the `defaultToken` properties value.
| `start` | Defaults to `'root'`. Sets the start state of the tokenizer.



## States

_States_ are named lists of _rules_ that can be switched to and from as a document is tokenized. The currently active state is determined by the _stack_, which can be manipulated through the rules present in the currently active state.
```ts
type State = Rule[]

const tokenizer = {
  foo: [
    ...rules
  ],
  block: [
    ...rules
  ]
}
```

The start state, if not specified, is always `'root'`. The `start` property of the language will change this default state.

Usually, a state will have a simple name, e.g. `block`. However, states can have _sub-states_. They take the following form:
```ts
const tokenizer = {
  'state.substate1.substate2.etc': [ ...rules ]
}
```

Sub-states do not have to be literally present within the tokenizer to be useful. If a state isn't found by Monarch, its _parent_ will be searched by progressively decomposing sub-states from the name. As an example, if the current state of the stack was `comment.foo`, and the tokenizer had no such state as `comment.foo`, but did have `comment`, it would treat `comment` as the active state.

The reason sub-states are useful is because they store information about how a state was reached within their names. These names can be parsed by _actions_ in order to affect how the tokenizer progresses through the document.

## Rules

_Rules_ instruct the tokenizer what to match, how to 'tokenize' what it has matched, and how the tokenizer should progress past the match.

```ts
type Rule = [regex: RegExp, action: Action, next?: string]
```

They can be written in three ways:
```ts
let rule1 = [regex, action]
let rule2 = [regex, action, next]
let rule3 = { regex: regex, action: action }
```

The first two forms are simply terse alternatives for the last form, which is what the tokenizer actually uses when parsing.

A special type of rule is an _include directive_. It is a compile-time-only object that tells the compiler to duplicate the specified state's rules into the state where the directive presides. These are usually used for the sake of tidiness, organization, and 'don't-repeat-yourself'.

```ts
const rule = { include: 'foo' }
```

Rules contain only two types of objects, _regex_ and _actions_.

### regex
Monarch uses regular expressions to match against the document. In contrast to the original Monaco implementation of Monarch, `cm6-monarch` practically supports all of JavaScript's regex functionality, like lookahead and lookbehind.

```ts
const rule = [/(?<=\s)\w+/, 'scope']
```

Monarch provides a '_attribute_' syntax with regex. A Monarch tokenizer is defined within the `tokenizer` property of the language, but _attributes_ are special constants given as properties along with the `tokenizer` property.

```ts
type Attribute = RegExp | string | string[]

const lang = {
  attribute1: 'foo',
  attribute2: /[(){}]/,
  attribute3: ['foo', 'bar'],
  // examples
  control: /[\\`@~*=^$_[\]{}()#+\-.!/]/,
  keywordsAsync: ['async', 'await'],

  tokenizer: [
    ...states
  ]
}
```

Attributes can be referenced with the special `@` character in regex.

```ts
// matches 'async', 'await'
const rule1 = [/@keywordsAsync/, '']

// matches '\w+' unless the next char is in the `@control` attribute.
const rule2 = [/\w+(?!@control)/, '']
```

Attributes are simply inserted directly where they are found inside of a regex.

### Actions
_Actions_ inform the tokenizer about what to do after it has made a match. Actions have the most involved syntax - and so this document will break them down into their individual properties.

However, they do have some short-hands and alternative forms that should be described first.
```ts
type Action = { ... } | string | Action[]

const action1 = { token: 'foo' }
const action2 = 'foo'
const action3 = ['foo', 'bar']
```

The first two types are identical in effect. The last form is for _group matches_. Group matches effectively break a single regular expression into rules made from its individual capture group.
```ts
const rule = [/(match1)(match2)(match3)/, [action1, action2, action3]]
```

Actions can have the following properties:
| | |
| :-- | :-- |
| `token`        | Assigns the matched text to the specified token.                         |
| `next`         | Pushes, or pops states from the stack.                                   |
| `switchTo`     | Switches to states without pushing additional states on the stack.       |
| `goBack`       | Reverses the tokenizer's position by the specified number of characters. |
| `nextEmbedded` | Informs the parser what language to nest with, or to stop nesting with.  |
| `log`          | Logs a message whenever the rule is matched.                             |
| `parser`       | Directs the parser to open or close syntax blocks.                       |


A special type of action, _cases_, is exclusive with these properties.

#### Substitution
All action properties can make of use _substitutions_, which are literal substitutions derived from either the matched text or the current state/sub-states.

They can take three forms:
| | |
| :-- | :-- |
| `$#`  | Substitutes the rule's match, or match group in a group match. |
| `$n`  | where `n` is a number. Substitutes for the *n*th capture group. The entire match is the special group `$0`. |
| `$Sn` | where `n` is a number. Substitutes for the *n*th sub-state in the full state expansion. e.g. `$S2` matches `foo` in `comment.foo`. The entire state is the special group `$S0`. |

```ts
// matches the text with a token type equiavlent to the text of match2
const rule = [/(match1)(match2)/, { token: '$2' }]
```


#### `token`
The `token` property causes the matched text to become 'scoped', or 'tagged' with the specified token name. All actions, and in a roundabout way including _cases_, require the `token` property.

An action that is neither an array nor object but a string is interpreted as a short-hand for the token property. e.g. `'foo'` becomes `{ token: 'foo' }`

It can be in one of three forms:
| | |
| :-- | :-- |
| `foo` | as in lowercased. Lowercased token names signify a _styling_ tag. Tokens of this type will be automatically highlighted with CodeMirror's native highlighter tags, if the tag name itself is valid. Unknown tag names will automatically be exported in the languages `tags` property, which allows for specifying a custom highlighting style for that tag. |
| `Foo` | as in uppercase. Uppercased token names do not signify anything by themselves. They are intended to be used with the language's `configure` property, the same as a Lezer grammar. |
| `@rematch` | The special `@rematch` token type causes the tokenizer to completely reverse the current match's progress, and then restart the tokenizer from that point again. The purpose of this is that state changes are still processed. This allows you to 'cancel' or 'lookahead' with state changes. |

```ts
const action = { token: 'foo' }
```

#### `next`
The `next` property informs the tokenizer to make a state change before the next match.

It can be in one of four forms:
| | |
| :-- | :-- |
| `foo`     | Pushes the specified state to the stack, which makes it the active state. It can be prefixed with an `@` character, or left without one. |
| `@pop`    | Pops the current state from the stack and returns to the previous state. |
| `@push`   | Pushes the _current state_ to the stack. |
| `@popall` | Pops all states except for the very first, returning to top/root. |

```ts
// pushes, and then switches to the 'comment' tokenizer state
const action = { next: '@comment' }
```

#### `switchTo`
The `switchTo` property is much like `next` except that the state specified is switched to without altering the stack.

```ts
// switches to the 'comment' state without changing the depth of the stack
const action = { switchTo: '@comment' }
```

#### `goBack`
The `goBack` property directs the tokenizer to reverse position by the specified number of characters.
```ts
// goes back 5 characters
const action = { goBack: 5 }
```

#### `nextEmbedded`
The `nextEmbedded` property looks somewhat like the `next` property, but instead of states it nests embedded languages. Unlike `next`, you cannot stack `nextEmbedded`. It is more like a flag that is set, with the tokenizer tracking what range of text should be filled in with the specified language.

It is very likely that a grammar will use _substitution_ with this property. For example, Markdown code blocks which specify the language after a series of backticks. The language specifier text itself could be matched in a capture group and used as the value for `nextEmbedded`.

It takes two forms:
| | |
| :-- | :-- |
| `foo`  | where `foo` is the name of the language, such as `typescript` or `golang`. This sets the tokenizer to begin tracking the span of the text that is marked as specified language. |
| `@pop` | Terminates the range tracking procedure at the start of the token. |

```ts
const action = { nextEmbedded: 'typescript' }
```

#### `log`
The `log` property logs (with `console.log`) the specified message whenever the associated action executes.

```ts
const action = { log: 'my rule fired' }
```

#### `{ cases: {} }`
The special action type _cases_ is intentionally similar to the `switch -> case` syntax found in many programming languages. It allows the branching to differing actions depending on whether the matched text matches against certain patterns.

```ts
type Cases = { cases: {
  [guard: string]: Action
}}

const cases = { cases: {
  'foo'     : { token: 'bar' },
  'foobar'  : { token: 'foobar', next: '@foo' },
  '@default': { token: 'content' }
}}
```

The _guard_ expression can be in one of four forms:
| | |
| :-- | :-- |
| `foo` | as in does not start with `$` or `@`. This is parsed as _regex_, not as a simple string comparison. The regex provided is treated like any other regex in the tokenizer, although it does need to be escaped as it is a string. This form is technically a short-hand for `$#~foo`, which is explained in the next section. |
| `@bar` | as in an attribute. Matches against an attribute string or against all strings within an attribute array. See the section on _regex_ and _attributes_. |
| `@eos`     | Matches against the text being at the very end of the current line. |
| `@default` | Matches against any input, like the `default` case in an ordinary `switch -> case` statement. |

As eluded to, the previously shown 'regex' pattern is a short-hand for the syntax `[pat][op]match`.

The _pattern_ is any _substitution_, e.g. `$#`.

The _operator_ and _match_ are any of the following:
| | |
| :-- | :-- |
| `~regex or !~regex` | Tests the pattern against the regex or the negation of the regex. |
| `@attribute or !@attribute` | Tests if the pattern is an element of the attribute or if the pattern is not in the attribute. |
| `==string or !=string` | Tests if the pattern is equivalent (or not equivalent) to the given string. |

#### `parser`

The `parser` property attaches special meaning to the tokens it is defined on. Tokens with this property inform the parser to make special decisions, mainly opening and closing syntax nodes.

It can have a combination of two states, with two (optional) properties each:
| | |
| :-- | :-- |
| `open or close` | This directs the parser to open or close the given syntax nodes _after_ or _before_ the matched token.
| `start or end`  | This directs the parser to open or close the given syntax nodes _with_ the matched tokens _inside_ of the opened/closed node.

The 'syntax node' type given acts exactly like the `token` properties value type, with the exception of the `@rematch` string not being special. Generally, a language will use the `parser` property in conjunction with the capitalized `Foo` tags in order to support otherwise impossible language features.

```ts
type Exclusive = { open?: string[] | string, close?: string[] | string }
type Inclusive = { start?: string[] | string, end?: string[] | string}
type ParserAction = Exclusive & Inclusive

const exclusive = { token: 'foo', parser: { open: 'Block' } }
const inclusive = { token: 'bar', parser: { end: 'Block' } }
```

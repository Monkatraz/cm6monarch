/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMonarchLanguage, IMonarchLanguageBracket, empty, substituteMatches, fixCase, MonarchBracket, stateExists, IRule, ILexerMin, FuzzyAction, IBranch, IAction, ILexer } from './monarchCommon'

// This module exports the compiler for Monarch tokenizer definitions.

// Compile-time type helpers

function isArrayOf(elemType: (x: any) => boolean, obj: any): boolean {
	if (!obj) return false
	if (!(Array.isArray(obj))) return false
	for (const el of obj) if (!(elemType(el)))
		return false

	return true
}

function bool(prop: any, defValue: boolean): boolean {
	if (typeof prop === 'boolean') return prop
	return defValue
}

function string(prop: any, defValue: string): string {
	if (typeof (prop) === 'string') return prop
	return defValue
}


function arrayToHash(array: string[]): { [name: string]: true } {
	const result: any = {}
	for (const e of array) result[e] = true
	return result
}


function createKeywordMatcher(arr: string[], caseInsensitive: boolean = false): (str: string) => boolean {
	if (caseInsensitive) arr = arr.map(function (x) { return x.toLowerCase() })
	const hash = arrayToHash(arr)
	if (caseInsensitive) return function (word) {
		return hash[word.toLowerCase()] !== undefined && hash.hasOwnProperty(word.toLowerCase())
	}
	else return function (word) {
		return hash[word] !== undefined && hash.hasOwnProperty(word)
	}
}


// Lexer helpers

/**
 * Compiles a regular expression string, adding the 'i' flag if 'ignoreCase' is set, and the 'u' flag if 'unicode' is set.
 * Also replaces @\w+ or sequences with the content of the specified attribute
 */
function compileRegExp(lexer: ILexerMin, str: string, sticky = false): RegExp {
	let n = 0
	while (str.indexOf('@') >= 0 && n < 5) { // at most 5 expansions
		n++
		str = str.replace(/@(\w+)/g, function (s, attr?) {
			let sub = ''
			if (typeof (lexer[attr]) === 'string') {
				sub = lexer[attr]
			} else if (lexer[attr] && lexer[attr] instanceof RegExp) {
				sub = lexer[attr].source
			} else {
				if (lexer[attr] === undefined) {
					throw new Error('language definition does not contain attribute \'' + attr + '\', used at: ' + str)
				} else {
					throw new Error('attribute reference \'' + attr + '\' must be a string, used at: ' + str)
				}
			}
			return (empty(sub) ? '' : '(?:' + sub + ')')
		})
	}

	let flags = (sticky ? 'y' : '') + (lexer.ignoreCase ? 'i' : '') + (lexer.unicode ? 'u' : '')
	return new RegExp(str, flags)
}

/**
 * Compiles guard functions for case matches.
 * This compiles 'cases' attributes into efficient match functions.
 *
 */
function selectScrutinee(id: string, matches: string[], state: string, num: number): string | null {
	if (num < 0) {
		return id
	}
	if (num < matches.length) {
		return matches[num]
	}
	if (num >= 100) {
		num = num - 100
		let parts = state.split('.')
		parts.unshift(state)
		if (num < parts.length) {
			return parts[num]
		}
	}
	return null
}

function createGuard(lexer: ILexerMin, ruleName: string, tkey: string, val: FuzzyAction): IBranch {
	// get the scrutinee and pattern
	let scrut = -1 // -1: $!, 0-99: $n, 100+n: $Sn
	let oppat = tkey
	let matches = tkey.match(/^\$(([sS]?)(\d\d?)|#)(.*)$/)
	if (matches) {
		if (matches[3]) { // if digits
			scrut = parseInt(matches[3])
			if (matches[2]) {
				scrut = scrut + 100 // if [sS] present
			}
		}
		oppat = matches[4]
	}
	// get operator
	let op = '~'
	let pat = oppat
	if (!oppat || oppat.length === 0) {
		op = '!='
		pat = ''
	}
	else if (/^\w*$/.test(pat)) {  // just a word
		op = '=='
	}
	else {
		matches = oppat.match(/^(@|!@|~|!~|==|!=)(.*)$/)
		if (matches) {
			op = matches[1]
			pat = matches[2]
		}
	}

	// set the tester function
	let tester: (s: string, id: string, matches: string[], state: string, eos: boolean) => boolean

	// special case a regexp that matches just words
	if ((op === '~' || op === '!~') && /^(\w|\|)*$/.test(pat)) {
		let inWords = createKeywordMatcher(pat.split('|'), lexer.ignoreCase)
		tester = function (s) { return (op === '~' ? inWords(s) : !inWords(s)) }
	}
	else if (op === '@' || op === '!@') {
		let words = lexer[pat]
		if (!words) {
			throw new Error('the @ match target \'' + pat + '\' is not defined, in rule: ' + ruleName)
		}
		if (!(isArrayOf(function (elem) { return (typeof (elem) === 'string') }, words))) {
			throw new Error('the @ match target \'' + pat + '\' must be an array of strings, in rule: ' + ruleName)
		}
		let inWords = createKeywordMatcher(words, lexer.ignoreCase)
		tester = function (s) { return (op === '@' ? inWords(s) : !inWords(s)) }
	}
	else if (op === '~' || op === '!~') {
		if (pat.indexOf('$') < 0) {
			// precompile regular expression
			let re = compileRegExp(lexer, '^' + pat + '$')
			tester = function (s) { return (op === '~' ? re.test(s) : !re.test(s)) }
		}
		else {
			tester = function (s, id, matches, state) {
				let re = compileRegExp(lexer, '^' + substituteMatches(lexer, pat, id, matches, state) + '$')
				return re.test(s)
			}
		}
	}
	else { // if (op==='==' || op==='!=') {
		if (pat.indexOf('$') < 0) {
			let patx = fixCase(lexer, pat)
			tester = function (s) { return (op === '==' ? s === patx : s !== patx) }
		}
		else {
			let patx = fixCase(lexer, pat)
			tester = function (s, id, matches, state, eos) {
				let patexp = substituteMatches(lexer, patx, id, matches, state)
				return (op === '==' ? s === patexp : s !== patexp)
			}
		}
	}

	// return the branch object
	if (scrut === -1) {
		return {
			name: tkey, value: val, test: function (id, matches, state, eos) {
				return tester(id, id, matches, state, eos)
			}
		}
	}
	else {
		return {
			name: tkey, value: val, test: function (id, matches, state, eos) {
				let scrutinee = selectScrutinee(id, matches, state, scrut)
				return tester(!scrutinee ? '' : scrutinee, id, matches, state, eos)
			}
		}
	}
}

/**
 * Compiles an action: i.e. optimize regular expressions and case matches
 * and do many sanity checks.
 *
 * This is called only during compilation but if the lexer definition
 * contains user functions as actions (which is usually not allowed), then this
 * may be called during lexing. It is important therefore to compile common cases efficiently
 */
function compileAction(lexer: ILexerMin, ruleName: string, action: any): FuzzyAction {
	// [/regex/]
	if (!action) return { token: '' }
	// [/regex/, 'scope']
	else if (typeof (action) === 'string') return action
	// everything else
	else if (action.token || action.token === '') {
		if (typeof (action.token) !== 'string') throw new Error(
			'a \'token\' attribute must be of type string, in rule: ' + ruleName)

		// only copy specific typed fields (only happens once during compile Lexer)
		let newAction: IAction = { token: action.token }

		if (action.token.indexOf('$') >= 0)
			newAction.tokenSubst = true

		// brackets
		if (typeof (action.bracket) === 'string') {
			if (action.bracket === '@open') newAction.bracket = MonarchBracket.Open
			else if (action.bracket === '@close') newAction.bracket = MonarchBracket.Close
			else throw new Error(
				'a \'bracket\' attribute must be either \'@open\' or \'@close\', in rule: ' + ruleName)
		}
		// state handling
		if (action.next) {
			if (typeof (action.next) !== 'string') throw new Error(
				'the next state must be a string value in rule: ' + ruleName)

			let next: string = action.next
			if (!/^(@pop|@push|@popall)$/.test(next)) {
				// peel off starting @ sign
				if (next[0] === '@') next = next.substr(1)
				// no dollar substitution, we can check if the state exists
				if (next.indexOf('$') < 0) {
					if (!stateExists(lexer, substituteMatches(lexer, next, '', [], ''))) throw new Error(
						'the next state \'' + action.next + '\' is not defined in rule: ' + ruleName)
				}
			}
			newAction.next = next
		}

		// everything else

		if (typeof (action.goBack) === 'number')
			newAction.goBack = action.goBack

		if (typeof (action.switchTo) === 'string')
			newAction.switchTo = action.switchTo

		if (typeof (action.log) === 'string')
			newAction.log = action.log

		if (typeof (action.nextEmbedded) === 'string')
			newAction.nextEmbedded = action.nextEmbedded

		if ('parser' in action)
			newAction.parser = action.parser

		return newAction
	}
	else if (Array.isArray(action)) {
		let results: FuzzyAction[] = []
		for (let i = 0, len = action.length; i < len; i++)
			results[i] = compileAction(lexer, ruleName, action[i])

		return { group: results }
	}
	else if (action.cases) {
		// build an array of test cases
		let cases: IBranch[] = []
		let values = []

		// for each case, push a test function and result value
		for (let tkey in action.cases) {
			if (action.cases.hasOwnProperty(tkey)) {
				const val = compileAction(lexer, ruleName, action.cases[tkey])
				values.push(val)

				// what kind of case
				if (tkey === '@default' || tkey === '@' || tkey === '')
					cases.push({ test: undefined, value: val, name: tkey })

				else if (tkey === '@eos')
					cases.push({ test: function (id, matches, state, eos) { return eos }, value: val, name: tkey })

				// call separate function to avoid local variable capture
				else cases.push(createGuard(lexer, ruleName, tkey, val))
			}
		}

		// create a matching function
		const def = lexer.defaultToken
		return {
			case_values: values,
			test: function (id, matches, state, eos) {
				for (const _case of cases)
					if ((!_case.test || _case.test(id, matches, state, eos))) return _case.value
				return def
			}
		}
	}
	else throw new Error(
		'an action must be a string, an object with a \'token\' or \'cases\' attribute, ' +
		'or an array of actions; in rule: ' + ruleName)
}

/**
 * Helper class for creating matching rules
 */
class Rule implements IRule {
	public regex: RegExp = new RegExp('')
	public action: FuzzyAction = { token: '' }
	public matchOnlyAtLineStart: boolean = false

	constructor (public name: string) { }

	public setRegex(lexer: ILexerMin, re: string | RegExp): void {
		let sregex: string
		if (typeof (re) === 'string') sregex = re
		else if (re instanceof RegExp) sregex = (<RegExp>re).source
		else throw new Error(
			'rules must start with a match string or regular expression: ' + this.name)

		this.matchOnlyAtLineStart = (sregex.length > 0 && sregex[0] === '^')
		this.name = this.name + ': ' + sregex
		this.regex = compileRegExp(lexer, '(?:' + sregex + ')', true)
	}

	public setAction(lexer: ILexerMin, act: IAction, tokenTypes: Set<string>) {
		this.action = compileAction(lexer, this.name, act)
		// every action runs through here, so we can get our token set this way
		if (typeof this.action === 'object' && 'group' in this.action)
			this.action.group!.forEach(act => addTokens(act, tokenTypes))
		if (typeof this.action === 'object' && 'case_values' in this.action)
			this.action.case_values!.forEach(act => addTokens(act, tokenTypes))
		else addTokens(this.action, tokenTypes)
	}
}

/** Parses an action and adds any tokens it finds to the lexer's token types. */
function addTokens(act: FuzzyAction, set: Set<string>) {
	const token = typeof act === 'string' ? act : act?.token ?? ''
	if (token && !token.startsWith('@')) set.add(token)
	if (typeof act !== 'string' && act.parser) {
		if ('open' in act.parser) set.add(act.parser.open!)
		if ('close' in act.parser) set.add(act.parser.close!)
		if ('start' in act.parser) set.add(act.parser.start!)
		if ('end' in act.parser) set.add(act.parser.end!)
	}
}

/** Compiles the given Monarch language definition into a Monarch lexer. */
export function compile(def: IMonarchLanguage): ILexer {
	if (!def || typeof (def) !== 'object') throw new Error(
		'Monarch: expecting a language definition object')

	// init. lexer object
	let lexer: ILexer = {} as any
	lexer.maxStack = 100
	lexer.start = (typeof def.start === 'string' ? def.start : null)
	lexer.ignoreCase = bool(def.ignoreCase, false)
	lexer.unicode = bool(def.unicode, false)
	lexer.defaultToken = string(def.defaultToken, 'source')
	lexer.tokenTypes = new Set
	if (lexer.defaultToken) lexer.tokenTypes.add(lexer.defaultToken)

	// For calling compileAction later on
	let lexerMin: ILexerMin = def as any
	lexerMin.ignoreCase = lexer.ignoreCase
	lexerMin.unicode = lexer.unicode
	lexerMin.stateNames = def.tokenizer
	lexerMin.defaultToken = lexer.defaultToken


	/** Maps messy rules from `rules` into compiled rules inside `newrules`. */
	function addRules(state: string, newrules: IRule[], rules: any[]) {
		for (const rule of rules) {

			// { include: '' }
			let include = rule.include
			if (include) {
				if (typeof (include) !== 'string')
					throw new Error('an \'include\' attribute must be a string at: ' + state)

				if (include[0] === '@') include = include.substr(1) // peel off starting @

				if (!def.tokenizer[include])
					throw new Error('include target \'' + include + '\' is not defined at: ' + state)

				addRules(state + '.' + include, newrules, def.tokenizer[include])
			}
			else {
				const newrule = new Rule(state)

				// Set up new rule attributes
				if (Array.isArray(rule) && rule.length >= 1 && rule.length <= 3) {

					newrule.setRegex(lexerMin, rule[0])

					// [/regex/, 'scope', 'next']
					if (rule.length >= 3) {
						if (typeof (rule[1]) === 'string')
							newrule.setAction(lexerMin, { token: rule[1], next: rule[2] }, lexer.tokenTypes)
						else if (typeof (rule[1]) === 'object') {
							const rule1 = rule[1]
							rule1.next = rule[2]
							newrule.setAction(lexerMin, rule1, lexer.tokenTypes)
						}
						else throw new Error(
							'a next state as the last element of a rule can only be given' +
							'if the action is either an object or a string, at: ' + state)
					}
					// [/regex/, 'scope' | { action }]
					else newrule.setAction(lexerMin, rule[1], lexer.tokenTypes)
				}
				// { regex, action }
				else {
					if (!rule.regex) throw new Error(
						'a rule must either be an array, or an object with a \'regex\' or \'include\' field at: ' + state)

					if (rule.name && typeof rule.name === 'string')
						newrule.name = rule.name

					if (rule.matchOnlyAtStart)
						newrule.matchOnlyAtLineStart = bool(rule.matchOnlyAtLineStart, false)

					newrule.setRegex(lexerMin, rule.regex)
					newrule.setAction(lexerMin, rule.action, lexer.tokenTypes)
				}

				newrules.push(newrule)
			}
		}
	}

	// compile the tokenizer rules

	if (!def.tokenizer || typeof (def.tokenizer) !== 'object') throw new Error(
		'a language definition must define the \'tokenizer\' attribute as an object')

	lexer.tokenizer = <any>[]
	for (let key in def.tokenizer) {
		if (def.tokenizer.hasOwnProperty(key)) {
			if (!lexer.start) lexer.start = key
			const rules = def.tokenizer[key]
			lexer.tokenizer[key] = new Array()
			addRules('tokenizer.' + key, lexer.tokenizer[key], rules)
		}
	}

	// brackets

	if (def.brackets && !(Array.isArray(<any>def.brackets)))
		throw new Error('the \'brackets\' attribute must be defined as an array')

	if (!def.brackets) {
		def.brackets = [
			{ open: '{', close: '}', token: 'brace' },
			{ open: '[', close: ']', token: 'squareBracket' },
			{ open: '(', close: ')', token: 'paren' },
			{ open: '<', close: '>', token: 'angleBracket' }]
	}
	let brackets: IMonarchLanguageBracket[] = []
	for (let el of def.brackets) {
		let desc: any = el
		if (desc && Array.isArray(desc) && desc.length === 3)
			desc = { token: desc[2], open: desc[0], close: desc[1] }
		if (desc.open === desc.close) throw new Error(
			'open and close brackets in a \'brackets\' attribute must be different: ' + desc.open +
			'\n hint: use the \'bracket\' attribute if matching on equal brackets is required.')

		if (typeof desc.open === 'string' && typeof desc.token === 'string' && typeof desc.close === 'string') {
			brackets.push({
				token: desc.token,
				open: fixCase(lexer, desc.open),
				close: fixCase(lexer, desc.close)
			})
		}
		else throw new Error(
			'every element in the \'brackets\' array must be a \'{open,close,token}\' object or array')
	}
	lexer.brackets = brackets

	return lexer
}

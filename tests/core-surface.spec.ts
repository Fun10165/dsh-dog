/**
 * The `./core` subpath is the contract embedders build against; the bundled
 * chunk names behind it are not. A missing symbol here means downstream code
 * has to reach into `lib/*.js`, which breaks on any rebuild — so this test
 * pins the surface.
 */
import { describe, expect, it } from 'vitest'
import * as core from '../src/core/index.ts'

describe('core surface', () => {
	it('exports the engine, storage and script resolution by name', () => {
		expect(typeof core.DogEngine).toBe('function')
		expect(typeof core.DogRepository).toBe('function')
		expect(typeof core.resolveScriptPath).toBe('function')
	})

	it('exports graph parsing, verifier runners and workspace pieces', () => {
		expect(typeof core.parseGraph).toBe('function')
		expect(typeof core.DogValidationError).toBe('function')
		expect(typeof core.runPlan).toBe('function')
		expect(typeof core.WorkspaceManager).toBe('function')
		expect(typeof core.sha256Json).toBe('function')
	})

	it('exports the dynamic DoG model, lifecycle, and store', () => {
		expect(core.DDOG_SCHEMA_VERSION).toBe('0.1')
		expect(typeof core.DdogStore).toBe('function')
		expect(typeof core.parseDdogGraph).toBe('function')
		expect(typeof core.applyObservation).toBe('function')
		expect(core.DEFAULT_DDOG_THRESHOLDS).toEqual({
			promotionFailures: 2,
			promotionFailureRate: 0.2,
			retirementSuccessRate: 0.9,
			retirementConsistency: 0.8,
			retirementMinRuns: 5,
		})
	})

	it('does not pull the Cordis plugin half', () => {
		expect('apply' in core).toBe(false)
		expect('registerDogDebugRoutes' in core).toBe(false)
	})
})

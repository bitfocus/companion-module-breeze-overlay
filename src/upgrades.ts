// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

/**
 * Config migrations, run once per connection when the module version changes.
 *
 * Once an entry is added here it can never be removed: a user upgrading from
 * any older version has to be able to replay the whole chain.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	/**
	 * 1.1.0 — NEXT gained a Table field.
	 *
	 * Filled in as blank on every NEXT placed under 1.0, which is exactly what
	 * those buttons already did: a plain NEXT, aimed at no table. Without it the
	 * option would arrive undefined, and a button that has worked for a season
	 * should not depend on every callback remembering that it might.
	 */
	(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> => {
		const updatedActions = props.actions.filter((action) => {
			if (action.actionId !== 'next' || action.options['table'] !== undefined) return false
			action.options['table'] = { value: '', isExpression: false }
			return true
		})
		return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
	},
]

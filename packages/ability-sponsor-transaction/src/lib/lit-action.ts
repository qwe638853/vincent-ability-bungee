import type { z } from 'zod';

import { vincentAbilityHandler } from '@lit-protocol/vincent-ability-sdk';

import type { abilityParamsSchema } from './schemas';

import { vincentAbility } from './vincent-ability';

declare const abilityParams: z.infer<typeof abilityParamsSchema>;
declare const context: {
  delegatorPkpEthAddress: string;
};

(async () => {
  const func = vincentAbilityHandler({
    vincentAbility: vincentAbility,
    context: {
      delegatorPkpEthAddress: context.delegatorPkpEthAddress,
    },
    abilityParams,
  });
  await func();
})();

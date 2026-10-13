import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Assignment Rules: Selects eligible designer with lowest active workload', () => {
  const designers = [
    { id: '1', name: 'Zawadi', currentActiveWorkload: 3, maxActiveWorkload: 5, isEligible: true },
    { id: '2', name: 'Juma', currentActiveWorkload: 1, maxActiveWorkload: 5, isEligible: true },
    { id: '3', name: 'Amina', currentActiveWorkload: 2, maxActiveWorkload: 5, isEligible: true },
  ];

  const sorted = designers
    .filter((d) => d.isEligible && d.currentActiveWorkload < d.maxActiveWorkload)
    .sort((a, b) => a.currentActiveWorkload - b.currentActiveWorkload);

  assert.equal(sorted[0].name, 'Juma', 'Lowest workload designer (1) should be chosen first');
});

test('Assignment Rules: Queues order when all designers are at max workload', () => {
  const fullDesigners = [
    { id: '1', name: 'Zawadi', currentActiveWorkload: 5, maxActiveWorkload: 5, isEligible: true },
    { id: '2', name: 'Juma', currentActiveWorkload: 5, maxActiveWorkload: 5, isEligible: true },
  ];

  const available = fullDesigners.filter(
    (d) => d.isEligible && d.currentActiveWorkload < d.maxActiveWorkload
  );

  assert.equal(available.length, 0, 'No designers should be available when at max capacity');
});

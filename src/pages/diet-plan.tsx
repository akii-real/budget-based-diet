import React, { useEffect, useState, useCallback, useRef } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/router';
import { Pie } from 'react-chartjs-2';
import 'chart.js/auto';

type QueryValue = string | string[] | undefined;
type PlanGenerationState =
  | 'idle'
  | 'loadingFirst'
  | 'prefetching'
  | 'batching'
  | 'ready'
  | 'partialReady'
  | 'error';
type RecipeLike = Record<string, string | number | undefined>;
type MealGroups = {
  Breakfast: RecipeLike[];
  Lunch: RecipeLike[];
  Snacks: RecipeLike[];
  Dinner: RecipeLike[];
};
type PlanCache = {
  version: number;
  createdAt: number;
  profileKey: string;
  plans: MealGroups[];
  activeIndex: number;
  seenRecipeNames: string[];
  exhausted: boolean;
};
type FetchPlanOptions = {
  variationSeed?: number;
  excludeRecipeNames?: string[];
};
type AppError = Error & { code?: string; status?: number };

const q = (v: QueryValue): string => (Array.isArray(v) ? v[0] : v) || '';
const parseRecipeCost = (meal: RecipeLike): number => {
  const fromEstimated = Number(
    String(meal['Estimated Cost (?)'] ?? '').replace(/[^0-9.]/g, '')
  );
  if (!Number.isNaN(fromEstimated) && Number.isFinite(fromEstimated))
    return fromEstimated;
  const fromCost = Number(meal.cost ?? 0);
  return Number.isFinite(fromCost) ? fromCost : 0;
};

const PLAN_POOL_SIZE = 5;
const PLAN_POOL_VERSION = 2;
const PLAN_POOL_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 180000;

const DietPlan = () => {
  const router = useRouter();
  const { name, age, height, weight, sex, dietGoal, budget, preference } =
    router.query;
  const userBudget = Number(q(budget) || 0);

  const [calories, setCalories] = useState(0);
  const [macros, setMacros] = useState({ protein: 0, carbs: 0, fat: 0 });
  const [mealGroups, setMealGroups] = useState<MealGroups>({
    Breakfast: [],
    Lunch: [],
    Snacks: [],
    Dinner: [],
  });
  const [, setPlanLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [generationState, setGenerationState] =
    useState<PlanGenerationState>('idle');
  const [prefetchNote, setPrefetchNote] = useState('');
  const [poolProgress, setPoolProgress] = useState({
    done: 0,
    total: PLAN_POOL_SIZE,
  });
  const poolWriteLockRef = useRef(false);

  const profileKey = [
    q(name),
    q(age),
    q(height),
    q(weight),
    q(sex),
    q(dietGoal),
    q(budget),
    q(preference),
  ].join('|');

  const readPoolCache = useCallback((): PlanCache | null => {
    try {
      const raw = localStorage.getItem('mealPlanPool');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PlanCache;
      if (!parsed || parsed.profileKey !== profileKey) return null;
      if (parsed.version !== PLAN_POOL_VERSION) return null;
      if (
        !parsed.createdAt ||
        Date.now() - Number(parsed.createdAt) > PLAN_POOL_TTL_MS
      )
        return null;
      if (!Array.isArray(parsed.plans) || parsed.plans.length === 0)
        return null;
      if (!Array.isArray(parsed.seenRecipeNames)) parsed.seenRecipeNames = [];
      if (typeof parsed.exhausted !== 'boolean') parsed.exhausted = false;
      return parsed;
    } catch {
      return null;
    }
  }, [profileKey]);

  const writePoolCache = useCallback(
    (cache: PlanCache) => {
      localStorage.setItem('mealPlanPool', JSON.stringify(cache));
      localStorage.setItem('mealPlanProfile', profileKey);
    },
    [profileKey]
  );

  const mergePoolCache = useCallback(
    (updater: (latest: PlanCache | null) => PlanCache | null) => {
      if (poolWriteLockRef.current) return null;
      poolWriteLockRef.current = true;
      try {
        const latest = readPoolCache();
        const next = updater(latest);
        if (!next) return latest;
        const stamped = {
          ...next,
          version: PLAN_POOL_VERSION,
          createdAt: next.createdAt || Date.now(),
        };
        writePoolCache(stamped);
        return stamped;
      } finally {
        poolWriteLockRef.current = false;
      }
    },
    [readPoolCache, writePoolCache]
  );

  const setActivePlanFromCache = useCallback((cache: PlanCache) => {
    const idx = Math.min(
      Math.max(cache.activeIndex || 0, 0),
      cache.plans.length - 1
    );
    const activePlan = cache.plans[idx];
    if (!activePlan) return;
    setMealGroups(activePlan);
    // Back-compat: keep the single-plan key updated for older reads.
    localStorage.setItem('mealPlan', JSON.stringify(activePlan));
  }, []);

  const extractRecipeNames = useCallback((groups: MealGroups) => {
    const names: string[] = [];
    for (const slot of Object.values(groups || {})) {
      for (const r of slot) {
        const n = r?.['Recipe name'];
        if (typeof n === 'string' && n.trim()) names.push(n.trim());
      }
    }
    return names;
  }, []);

  useEffect(() => {
    if (q(age) && q(height) && q(weight) && q(sex) && q(dietGoal)) {
      const bmr =
        q(sex) === 'Male'
          ? 10 * +q(weight) + 6.25 * +q(height) - 5 * +q(age) + 5
          : 10 * +q(weight) + 6.25 * +q(height) - 5 * +q(age) - 161;
      let totalCal;
      if (q(dietGoal) === 'Weight Gain')
        totalCal = Math.round(bmr * 1.55 + 500);
      else if (q(dietGoal) === 'Weight Loss')
        totalCal = Math.round(bmr * 1.2 - 300);
      else totalCal = Math.round(bmr * 1.55);
      setCalories(totalCal);
      setMacros({
        protein: Math.round((totalCal * 0.3) / 4),
        carbs: Math.round((totalCal * 0.5) / 4),
        fat: Math.round((totalCal * 0.2) / 9),
      });
    }
  }, [age, height, weight, sex, dietGoal]);

  const fetchAiPlan = useCallback(
    async (opts?: FetchPlanOptions): Promise<MealGroups> => {
      const variationSeed = opts?.variationSeed;
      const excludeRecipeNames = opts?.excludeRecipeNames;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res;
      let data;
      try {
        res = await fetch('/api/ai-meal-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            name: q(name),
            age: q(age),
            height: q(height),
            weight: q(weight),
            sex: q(sex),
            dietGoal: q(dietGoal),
            preference: q(preference),
            budget: userBudget,
            calories,
            macros,
            ...(variationSeed != null ? { variationSeed } : {}),
            ...(excludeRecipeNames && excludeRecipeNames.length
              ? { excludeRecipeNames }
              : {}),
          }),
        });
        data = await res.json();
      } catch (e: unknown) {
        const fetchError = e as { name?: string };
        if (fetchError?.name === 'AbortError') {
          const err = new Error(
            'Meal plan request timed out. Please try again.'
          ) as AppError;
          err.code = 'OLLAMA_TIMEOUT';
          throw err;
        }
        const err = new Error(
          'Network error while generating meal plan.'
        ) as AppError;
        err.code = 'NETWORK_ERROR';
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        const rawError = data?.error || 'Could not generate meal plan.';
        if (String(rawError).includes('No AI provider configured')) {
          const err = new Error(
            'AI is not configured. Set OLLAMA_MODEL in .env.local (with Ollama running and the model pulled), then restart Next.js.'
          ) as AppError;
          err.code = data?.code || 'NO_AI_PROVIDER';
          throw err;
        }
        const err = new Error(rawError) as AppError;
        err.code = data?.code || `HTTP_${res.status}`;
        err.status = res.status;
        throw err;
      }
      if (!data.mealGroups || typeof data.mealGroups !== 'object') {
        const err = new Error(
          'Invalid response from AI meal planner.'
        ) as AppError;
        err.code = 'INVALID_MEAL_PLAN';
        throw err;
      }
      return data.mealGroups as MealGroups;
    },
    [
      name,
      age,
      height,
      weight,
      sex,
      dietGoal,
      preference,
      userBudget,
      calories,
      macros,
    ]
  );

  const fetchAiPlanWithRetry = useCallback(
    async (opts?: FetchPlanOptions): Promise<MealGroups> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const nextOpts =
            attempt === 0
              ? opts
              : {
                  ...(opts || {}),
                  variationSeed: Date.now() + attempt,
                };
          return await fetchAiPlan(nextOpts);
        } catch (e: unknown) {
          lastErr = e;
          const nonRetryableCodes = new Set([
            'INVALID_BODY',
            'NO_AI_PROVIDER',
            'NO_MORE_RECIPES_BUDGET',
            'INVALID_MEAL_PLAN',
          ]);
          const code = (e as AppError)?.code || '';
          if (nonRetryableCodes.has(code)) break;
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      }
      throw (lastErr as Error) || new Error('Could not generate meal plan.');
    },
    [fetchAiPlan]
  );

  useEffect(() => {
    const ready =
      q(age) &&
      q(height) &&
      q(weight) &&
      q(sex) &&
      q(dietGoal) &&
      q(budget) &&
      calories > 0 &&
      userBudget > 0;

    if (!ready) {
      setPlanLoading(false);
      setGenerationState('error');
      setPlanError(
        'Please complete Get Started with valid values, including a budget greater than 0.'
      );
      return;
    }

    const cachedPool = readPoolCache();
    if (cachedPool) {
      setPoolProgress({
        done: Math.min(cachedPool.plans.length, PLAN_POOL_SIZE),
        total: PLAN_POOL_SIZE,
      });
      setActivePlanFromCache(cachedPool);
      setGenerationState('ready');
      setPlanLoading(false);
      return;
    }

    let cancelled = false;
    setPlanLoading(true);
    setGenerationState('loadingFirst');
    setPlanError(null);
    setPrefetchNote('');
    setPoolProgress({ done: 0, total: PLAN_POOL_SIZE });

    (async () => {
      try {
        // Generate the first plan (blocking) so the user sees something ASAP.
        const first = await fetchAiPlanWithRetry();
        if (cancelled) return;
        const firstNames = extractRecipeNames(first);
        const initialCache = {
          version: PLAN_POOL_VERSION,
          createdAt: Date.now(),
          profileKey,
          plans: [first],
          activeIndex: 0,
          seenRecipeNames: firstNames,
          exhausted: false,
        };
        writePoolCache(initialCache);
        setPoolProgress({ done: 1, total: PLAN_POOL_SIZE });
        setActivePlanFromCache(initialCache);
        setGenerationState('prefetching');

        // Prefetch the remaining plans in the background (sequential to avoid overload).
        for (let i = 1; i < PLAN_POOL_SIZE; i++) {
          if (cancelled) return;
          try {
            const current = readPoolCache() || initialCache;
            const next = await fetchAiPlanWithRetry({
              variationSeed: Date.now() + i,
              excludeRecipeNames: current.seenRecipeNames,
            });
            if (cancelled) return;
            const updated = mergePoolCache((latest) => {
              const base = latest || current || initialCache;
              // Avoid unbounded growth; keep only the first PLAN_POOL_SIZE.
              const plans = [...(base.plans || []), next].slice(
                0,
                PLAN_POOL_SIZE
              );
              const moreNames = extractRecipeNames(next);
              const seenRecipeNames = [
                ...(base.seenRecipeNames || []),
                ...moreNames,
              ].slice(0, 600);
              return {
                ...base,
                profileKey,
                plans,
                activeIndex: base.activeIndex || 0,
                seenRecipeNames,
                exhausted: false,
              };
            });
            setPoolProgress({
              done: (updated?.plans || current?.plans || []).length,
              total: PLAN_POOL_SIZE,
            });
          } catch (e: unknown) {
            console.warn('prefetch plan failed:', e);
            setPrefetchNote(
              'Some alternatives could not be prefetched. "Different Option" will fetch more on demand.'
            );
            setGenerationState('partialReady');
            break;
          }
        }
        if (!cancelled) setGenerationState('ready');
      } catch (e: unknown) {
        console.error(e);
        if (!cancelled) {
          setPlanError(
            e instanceof Error ? e.message : 'Failed to build your meal plan.'
          );
          setGenerationState('error');
        }
      } finally {
        if (!cancelled) setPlanLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    age,
    height,
    weight,
    sex,
    dietGoal,
    budget,
    preference,
    name,
    calories,
    userBudget,
    macros,
    profileKey,
    fetchAiPlanWithRetry,
    readPoolCache,
    writePoolCache,
    mergePoolCache,
    setActivePlanFromCache,
    extractRecipeNames,
  ]);

  const generateNextBatch = useCallback(async () => {
    const cachedPool = readPoolCache();
    if (!cachedPool || cachedPool.exhausted) return;

    setPlanLoading(true);
    setGenerationState('batching');
    setPlanError(null);
    setPrefetchNote('');
    setPoolProgress({ done: 0, total: PLAN_POOL_SIZE });
    try {
      const newPlans: MealGroups[] = [];
      let seen = cachedPool.seenRecipeNames || [];

      for (let i = 0; i < PLAN_POOL_SIZE; i++) {
        const next = await fetchAiPlanWithRetry({
          variationSeed: Date.now() + i,
          excludeRecipeNames: seen,
        });
        newPlans.push(next);
        seen = [...seen, ...extractRecipeNames(next)].slice(0, 1000);
        setPoolProgress({ done: i + 1, total: PLAN_POOL_SIZE });
      }

      const merged = {
        ...cachedPool,
        version: PLAN_POOL_VERSION,
        createdAt: Date.now(),
        profileKey,
        plans: [...cachedPool.plans, ...newPlans],
        activeIndex: cachedPool.plans.length, // jump to first of new batch
        seenRecipeNames: seen,
        exhausted: false,
      };
      writePoolCache(merged);
      setActivePlanFromCache(merged);
      setGenerationState('ready');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // If API explicitly says no more recipes within budget, keep old pool and mark exhausted.
      if (msg.toLowerCase().includes('no more recipes available')) {
        const updated = {
          ...cachedPool,
          exhausted: true,
          version: PLAN_POOL_VERSION,
          createdAt: Date.now(),
        };
        writePoolCache(updated);
        setPlanError(
          'No more recipes in the given budget constraints. Would you like to select from the previously provided options?'
        );
        setGenerationState('partialReady');
      } else {
        setPlanError(msg || 'Could not generate more options.');
        setGenerationState('error');
      }
    } finally {
      setPlanLoading(false);
    }
  }, [
    extractRecipeNames,
    fetchAiPlanWithRetry,
    profileKey,
    readPoolCache,
    setActivePlanFromCache,
    writePoolCache,
  ]);

  const generateFreshPlan = useCallback(async () => {
    setPlanLoading(true);
    setGenerationState('loadingFirst');
    setPlanError(null);
    setPrefetchNote('');
    setPoolProgress({ done: 0, total: PLAN_POOL_SIZE });
    try {
      const first = await fetchAiPlanWithRetry({ variationSeed: Date.now() });
      const firstNames = extractRecipeNames(first);
      const initialCache = {
        version: PLAN_POOL_VERSION,
        createdAt: Date.now(),
        profileKey,
        plans: [first],
        activeIndex: 0,
        seenRecipeNames: firstNames,
        exhausted: false,
      };
      writePoolCache(initialCache);
      setPoolProgress({ done: 1, total: PLAN_POOL_SIZE });
      setActivePlanFromCache(initialCache);
      setGenerationState('ready');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPlanError(msg || 'Could not generate a new option.');
      setGenerationState('error');
    } finally {
      setPlanLoading(false);
    }
  }, [
    extractRecipeNames,
    fetchAiPlanWithRetry,
    profileKey,
    setActivePlanFromCache,
    writePoolCache,
  ]);

  const refreshPlan = async () => {
    const cachedPool = readPoolCache();
    if (!cachedPool) {
      await generateFreshPlan();
      return;
    }
    // If we have another plan already cached, just advance.
    if (cachedPool && cachedPool.activeIndex + 1 < cachedPool.plans.length) {
      const updated = {
        ...cachedPool,
        activeIndex: cachedPool.activeIndex + 1,
      };
      writePoolCache(updated);
      setActivePlanFromCache(updated);
      return;
    }

    // If exhausted, cycle through existing options (ask user to select from previous).
    if (cachedPool?.exhausted && cachedPool.plans.length) {
      const updated = { ...cachedPool, activeIndex: 0 };
      writePoolCache(updated);
      setActivePlanFromCache(updated);
      return;
    }

    // Otherwise, we finished the current batch: generate the next batch of 5.
    await generateNextBatch();
  };

  const totalPlanCalories = (Object.values(mealGroups) as RecipeLike[][])
    .flat()
    .reduce((s, m) => s + Number(m['Calories (kcal)'] || 0), 0);

  const totalPlanCost = (Object.values(mealGroups) as RecipeLike[][])
    .flat()
    .reduce((s, m) => s + parseRecipeCost(m), 0);
  const currentPlanMacros = (Object.values(mealGroups) as RecipeLike[][])
    .flat()
    .reduce<{ protein: number; carbs: number; fat: number }>(
      (acc, m: RecipeLike) => ({
        protein:
          acc.protein +
          Number(String(m['Protein (g)'] ?? 0).replace(/[^0-9.]/g, '')),
        carbs:
          acc.carbs +
          Number(String(m['Carbs (g)'] ?? 0).replace(/[^0-9.]/g, '')),
        fat:
          acc.fat + Number(String(m['Fats (g)'] ?? 0).replace(/[^0-9.]/g, '')),
      }),
      { protein: 0, carbs: 0, fat: 0 }
    );
  const hasAnyMeals = Object.values(mealGroups).some(
    (items) => Array.isArray(items) && items.length > 0
  );
  const isBusy =
    generationState === 'loadingFirst' ||
    generationState === 'prefetching' ||
    generationState === 'batching';

  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen bg-cover bg-center p-10 w-full"
      style={{ backgroundImage: `url('/assets/images/image.jpg')` }}
    >
      <div className="bg-white bg-opacity-90 backdrop-blur-md p-10 shadow-lg rounded-lg text-center max-w-4xl w-full">
        <h1 className="text-4xl font-bold text-red-600">Your Diet Plan</h1>
        <p className="text-gray-700 mt-4">
          <strong>{q(name) || '—'}</strong>, you need{' '}
          <strong>{calories} kcal</strong> per day for{' '}
          <strong>{q(dietGoal) || '—'}</strong>, with a budget of{' '}
          <strong>₹{userBudget}</strong>.
        </p>
        <p className="mt-2 text-green-700 font-medium">
          Plan: {totalPlanCalories} kcal, ₹{totalPlanCost.toFixed(2)} total cost
        </p>
        {planError && <p className="mt-2 text-red-600 text-sm">{planError}</p>}
        {prefetchNote && (
          <p className="mt-2 text-amber-700 text-sm">{prefetchNote}</p>
        )}
        {isBusy && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span>
                Generating meal plans… (
                {Math.min(poolProgress.done, poolProgress.total)}/
                {poolProgress.total})
              </span>
              <span>
                {Math.round(
                  (Math.min(poolProgress.done, poolProgress.total) /
                    poolProgress.total) *
                    100
                )}
                %
              </span>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{
                  width: `${Math.round(
                    (Math.min(poolProgress.done, poolProgress.total) /
                      poolProgress.total) *
                      100
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-6 text-left w-full grid grid-cols-2 gap-6">
          <div className="w-64 h-64 mx-auto">
            <Pie
              data={{
                labels: ['Protein (g)', 'Carbs (g)', 'Fat (g)'],
                datasets: [
                  {
                    data: [
                      currentPlanMacros.protein,
                      currentPlanMacros.carbs,
                      currentPlanMacros.fat,
                    ],
                    backgroundColor: ['#ff6384', '#36a2eb', '#ffcd56'],
                  },
                ],
              }}
              options={{
                plugins: {
                  tooltip: {
                    callbacks: {
                      label: (ti) => `${ti.label}: ${ti.raw}g`,
                    },
                  },
                },
              }}
            />
          </div>
        </div>

        {isBusy ? (
          <p className="mt-8 text-lg text-gray-700">
            Building your personalized plan…
          </p>
        ) : !hasAnyMeals ? (
          <div className="mt-8 text-gray-700">
            <p className="text-lg font-medium">
              Could not build a complete meal plan right now.
            </p>
            <p className="text-sm mt-1">
              Click <strong>Different Option</strong> to retry with a fresh
              generation.
            </p>
          </div>
        ) : (
          Object.entries(mealGroups).map(([mealType, items]) => (
            <div key={mealType} className="mt-6">
              <h2 className="text-2xl font-bold">{mealType}</h2>
              <div className="text-left mt-4 w-full grid grid-cols-2 gap-6">
                {items.length === 0 ? (
                  <p className="text-gray-600 col-span-2">
                    No meals in this slot.
                  </p>
                ) : (
                  items.map((meal, i) => (
                    <div key={i} className="bg-gray-100 p-4 rounded-lg shadow">
                      <Link
                        href={{
                          pathname: '/recipe',
                          query: {
                            name: meal['Recipe name'],
                            mealType,
                          },
                        }}
                        className="font-bold text-lg text-blue-600 hover:underline"
                      >
                        {meal['Recipe name']}
                      </Link>
                      <p>
                        <strong>Calories:</strong> {meal['Calories (kcal)']}{' '}
                        kcal
                      </p>
                      <p>
                        <strong>Protein:</strong> {meal['Protein (g)']} g
                      </p>
                      <p>
                        <strong>Fats:</strong> {meal['Fats (g)']} g
                      </p>
                      <p>
                        <strong>Cost:</strong> ₹
                        {parseRecipeCost(meal).toFixed(2)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}

        <div className="mt-6 flex justify-center space-x-6 flex-wrap gap-y-3">
          <button
            type="button"
            onClick={() => refreshPlan()}
            disabled={isBusy}
            className="bg-blue-500 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-blue-600 transition disabled:opacity-50"
          >
            Different Option
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('mealPlan');
              localStorage.removeItem('mealPlanPool');
              localStorage.removeItem('mealPlanProfile');
              router.push('/');
            }}
            className="bg-red-500 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-red-600 transition"
          >
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
};

export default DietPlan;

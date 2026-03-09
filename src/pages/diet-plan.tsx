import React, { useEffect, useState } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/router';
import Papa from 'papaparse';
import { Pie } from 'react-chartjs-2';
import 'chart.js/auto';

const DietPlan = () => {
  const router = useRouter();
  const { name, age, height, weight, sex, dietGoal, budget } = router.query;
  const userBudget = Number(budget || 0);

  const [calories, setCalories] = useState(0);
  const [macros, setMacros] = useState({ protein: 0, carbs: 0, fat: 0 });
  const [meals, setMeals] = useState([]);
  const [mealGroups, setMealGroups] = useState({
    Breakfast: [],
    Lunch: [],
    Snacks: [],
    Dinner: [],
  });

  // 1) compute calories & macros
  useEffect(() => {
    if (age && height && weight && sex && dietGoal) {
      const bmr =
        sex === 'Male'
          ? 10 * +weight + 6.25 * +height - 5 * +age + 5
          : 10 * +weight + 6.25 * +height - 5 * +age - 161;
      let totalCal;
      if (dietGoal === 'Weight Gain') totalCal = Math.round(bmr * 1.55 + 500);
      else if (dietGoal === 'Weight Loss')
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

  // 2) fetch CSV once
  useEffect(() => {
    fetch('/data/meal_plan.csv')
      .then((r) => r.text())
      .then((txt) => {
        const { data } = Papa.parse(txt, { header: true });
        setMeals(
          data.map((m) => ({
            ...m,
            cost: Number(m['Estimated Cost (₹)'] || 0),
          }))
        );
      });
  }, []);

  // helper to shuffle
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // 3) generate plan respecting both calories & budget
  const generateMealPlan = () => {
    const dist = { Breakfast: 0.25, Lunch: 0.35, Snacks: 0.15, Dinner: 0.25 };
    const plan = {};
    Object.entries(dist).forEach(([mealType, pct]) => {
      const targetCal = calories * pct;
      const minCal = targetCal * 0.9;
      const maxCal = targetCal * 1.1;
      const maxCost = userBudget * pct;

      let cSum = 0;
      let costSum = 0;
      const picks = [];
      const pool = shuffle(meals.filter((m) => m['Meal Type'] === mealType));

      for (const m of pool) {
        const mc = +m['Calories (kcal)'];
        const { cost } = m;
        if (cSum + mc <= maxCal && costSum + cost <= maxCost) {
          picks.push(m);
          cSum += mc;
          costSum += cost;
        }
        if (cSum >= minCal) break;
      }
      plan[mealType] = picks;
    });
    return plan;
  };

  // 4) when meals/calories/budget ready, rebuild plan only if not already saved
  useEffect(() => {
    if (meals.length && calories > 0 && userBudget > 0) {
      const existingPlan = localStorage.getItem('mealPlan');
      if (existingPlan) {
        setMealGroups(JSON.parse(existingPlan));
      } else {
        const newPlan = generateMealPlan();
        setMealGroups(newPlan);
        localStorage.setItem('mealPlan', JSON.stringify(newPlan));
      }
    }
  }, [meals, calories, userBudget]);

  const totalPlanCalories = Object.values(mealGroups)
    .flat()
    .reduce((s, m) => s + Number(m['Calories (kcal)'] || 0), 0);

  const totalPlanCost = Object.values(mealGroups)
    .flat()
    .reduce((s, m) => s + (m.cost || 0), 0);

  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen bg-cover bg-center p-10 w-full"
      style={{ backgroundImage: `url('/assets/images/image.jpg')` }}
    >
      <div className="bg-white bg-opacity-90 backdrop-blur-md p-10 shadow-lg rounded-lg text-center max-w-4xl w-full">
        <h1 className="text-4xl font-bold text-red-600">Your Diet Plan</h1>
        <p className="text-gray-700 mt-4">
          <strong>{name}</strong>, you need <strong>{calories} kcal</strong> per
          day for <strong>{dietGoal}</strong>, with a budget of{' '}
          <strong>₹{userBudget}</strong>.
        </p>
        <p className="mt-2 text-green-700 font-medium">
          Plan: {totalPlanCalories} kcal, ₹{totalPlanCost.toFixed(2)} total cost
        </p>

        <div className="mt-6 text-left w-full grid grid-cols-2 gap-6">
          <div className="w-64 h-64 mx-auto">
            <Pie
              data={{
                labels: ['Protein (g)', 'Carbs (g)', 'Fat (g)'],
                datasets: [
                  {
                    data: [macros.protein, macros.carbs, macros.fat],
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

        {Object.entries(mealGroups).map(([mealType, items]) => (
          <div key={mealType} className="mt-6">
            <h2 className="text-2xl font-bold">{mealType}</h2>
            <div className="text-left mt-4 w-full grid grid-cols-2 gap-6">
              {items.map((meal, i) => (
                <div key={i} className="bg-gray-100 p-4 rounded-lg shadow">
                  <Link
                    href={{
                      pathname: '/recipe',
                      query: { name: meal['Recipe name'] },
                    }}
                    className="font-bold text-lg text-blue-600 hover:underline"
                  >
                    {meal['Recipe name']}
                  </Link>
                  <p>
                    <strong>Calories:</strong> {meal['Calories (kcal)']} kcal
                  </p>
                  <p>
                    <strong>Protein:</strong> {meal['Protein (g)']} g
                  </p>
                  <p>
                    <strong>Fats:</strong> {meal['Fats (g)']} g
                  </p>
                  <p>
                    <strong>Cost:</strong> ₹
                    {meal?.cost ? meal.cost.toFixed(2) : 'N/A'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-6 flex justify-center space-x-6">
          <button
            onClick={() => {
              const newPlan = generateMealPlan();
              setMealGroups(newPlan);
              localStorage.setItem('mealPlan', JSON.stringify(newPlan));
            }}
            className="bg-blue-500 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-blue-600 transition"
          >
            Different Option
          </button>
          <button
            onClick={() => {
              localStorage.removeItem('mealPlan');
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

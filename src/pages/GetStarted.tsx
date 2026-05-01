import React, { useState } from 'react';

import axios from 'axios';
import { useRouter } from 'next/router';

type Preference = '' | 'veg' | 'non-veg';

const GetStarted = () => {
  const router = useRouter();

  const [formData, setFormData] = useState({
    name: '',
    age: '',
    height: '',
    weight: '',
    sex: '',
    dietGoal: '',
    budget: '',
    preference: '' as Preference,
  });
  const [submitting, setSubmitting] = useState(false);
  const [saveWarning, setSaveWarning] = useState('');

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    if (
      (name === 'age' ||
        name === 'height' ||
        name === 'weight' ||
        name === 'budget') &&
      Number(value) < 0
    )
      return;
    setFormData({ ...formData, [name]: value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSaveWarning('');
    const base = (
      process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:5000'
    ).replace(/\/$/, '');
    try {
      await axios.post(`${base}/save-data`, formData, { timeout: 8000 });
    } catch (error) {
      console.warn('Could not reach backend to save user data (Excel):', error);
      setSaveWarning(
        'Could not save profile to backend right now. Meal generation will continue.'
      );
    }
    try {
      await router.push({ pathname: '/diet-plan/', query: formData });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen bg-cover bg-center"
      style={{ backgroundImage: `url('/assets/images/image.jpg')` }}
    >
      <div className="bg-white p-10 shadow-lg rounded-lg text-center max-w-md">
        <h1 className="text-4xl font-bold text-red-600">
          Welcome to Diet Master Pro
        </h1>
        <p className="text-gray-700 mt-4">
          Enter your details to generate a personalized meal plan based on your
          goals.
        </p>
        {saveWarning && (
          <p className="text-amber-700 mt-3 text-sm">{saveWarning}</p>
        )}

        <form
          onSubmit={handleSubmit}
          className="mt-6 w-full flex flex-col gap-4"
        >
          <input
            type="text"
            name="name"
            placeholder="Name"
            value={formData.name}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full"
            required
          />
          <input
            type="number"
            name="age"
            placeholder="Age"
            value={formData.age}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full"
            min="0"
            required
          />
          <input
            type="number"
            name="height"
            placeholder="Height (cm)"
            value={formData.height}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full"
            min="0"
            required
          />
          <input
            type="number"
            name="weight"
            placeholder="Weight (kg)"
            value={formData.weight}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full"
            min="0"
            required
          />
          <input
            type="number"
            name="budget"
            placeholder="Budget (₹)"
            value={formData.budget}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full"
            min="1"
            required
          />
          <select
            name="sex"
            value={formData.sex}
            onChange={handleChange}
            className={[
              'p-2 border rounded-lg w-full',
              formData.sex ? 'text-gray-800' : 'text-gray-500',
            ].join(' ')}
            required
          >
            <option value="" hidden>
              Sex
            </option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>
          <select
            name="dietGoal"
            value={formData.dietGoal}
            onChange={handleChange}
            className={[
              'p-2 border rounded-lg w-full',
              formData.dietGoal ? 'text-gray-800' : 'text-gray-500',
            ].join(' ')}
            required
          >
            <option value="" hidden>
              Weight Goals
            </option>
            <option value="Weight Gain">Weight Gain</option>
            <option value="Weight Loss">Weight Loss</option>
            <option value="Weight Maintenance">Weight Maintenance</option>
          </select>

          <div className="w-full text-left">
            <div className="text-sm font-medium text-gray-700 mb-2">
              Preference
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() =>
                  setFormData((p) => ({ ...p, preference: 'veg' }))
                }
                className={[
                  'px-4 py-3 rounded-lg text-base font-semibold border transition',
                  formData.preference === 'veg'
                    ? 'bg-green-600 text-white border-green-700'
                    : 'bg-white text-green-700 border-green-300 hover:bg-green-50',
                ].join(' ')}
              >
                Veg
              </button>
              <button
                type="button"
                onClick={() =>
                  setFormData((p) => ({ ...p, preference: 'non-veg' }))
                }
                className={[
                  'px-4 py-3 rounded-lg text-base font-semibold border transition',
                  formData.preference === 'non-veg'
                    ? 'bg-red-600 text-white border-red-700'
                    : 'bg-white text-red-700 border-red-300 hover:bg-red-50',
                ].join(' ')}
              >
                Non‑Veg
              </button>
            </div>
            <input
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              required
              value={formData.preference}
              onChange={() => {}}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="bg-red-500 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-red-600 transition duration-300 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default GetStarted;

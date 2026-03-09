import React, { useState } from 'react';

import axios from 'axios';
import { useRouter } from 'next/router';

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
  });

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
    try {
      await axios.post('http://localhost:5000/save-data', formData);
      alert('Data saved successfully!');
      router.push({ pathname: '/diet-plan', query: formData });
    } catch (error) {
      console.error('Error saving data:', error);
      alert('Failed to save data.');
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
            min="0"
            required
          />
          <select
            name="sex"
            value={formData.sex}
            onChange={handleChange}
            className="p-2 border rounded-lg w-full text-gray-500"
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
            className="p-2 border rounded-lg w-full text-gray-500"
            required
          >
            <option value="" hidden>
              Weight Goals
            </option>
            <option value="Weight Gain">Weight Gain</option>
            <option value="Weight Loss">Weight Loss</option>
            <option value="Weight Maintenance">Weight Maintenance</option>
          </select>
          <button
            type="submit"
            className="bg-red-500 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-red-600 transition duration-300"
          >
            Submit
          </button>
        </form>
      </div>
    </div>
  );
};

export default GetStarted;

# Diet Maker API Documentation

## Base URL
```
http://localhost:5000
```

## Authentication
Currently, the API does not require authentication. Future updates will implement JWT-based authentication.

## Endpoints

### Save User Data
```http
POST /save-data
```

Saves user dietary information to the Excel file.

#### Request Body
```json
{
  "name": "John Doe",
  "age": 30,
  "height": 175,
  "weight": 70,
  "dietaryPreferences": ["vegetarian", "low-carb"],
  "allergies": ["nuts", "dairy"]
}
```

#### Response
```json
{
  "message": "Data saved successfully!"
}
```

#### Error Response
```json
{
  "message": "Error saving data"
}
```

### Scrape Ingredient Prices
```http
POST /scrape
```

Scrapes prices for a specific ingredient from various sources.

#### Request Body
```json
{
  "ingredient": "chicken breast"
}
```

#### Response
```json
{
  "message": "Scraped and saved successfully",
  "data": [
    {
      "name": "chicken breast",
      "source": "store1",
      "price": 5.99
    },
    {
      "name": "chicken breast",
      "source": "store2",
      "price": 6.49
    }
  ]
}
```

#### Error Response
```json
{
  "error": "Scraping failed"
}
```

## Error Codes

- 200: Success
- 400: Bad Request
- 500: Internal Server Error

## Rate Limiting

Currently, there are no rate limits implemented. Future updates will include rate limiting to prevent abuse.

## Data Models

### User Data Model
```typescript
interface UserData {
  name: string;
  age: number;
  height?: number;
  weight?: number;
  dietaryPreferences?: string[];
  allergies?: string[];
}
```

### Ingredient Price Model
```typescript
interface IngredientPrice {
  name: string;
  source: string;
  price: number;
}
```

## Future Enhancements

1. Authentication and Authorization
2. Rate Limiting
3. Input Validation
4. Error Handling
5. Caching
6. MongoDB Integration for all data storage 